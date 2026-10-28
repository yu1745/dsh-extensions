import { buildWindowRecoveryView } from './openai-window-recovery.mjs';
import { REMOTE_MARKER, replayRemoteCheckpoint, CheckpointError } from './openai-remote-checkpoint-prototype.mjs';
import { requestRemoteCompaction, RemoteCompactionError } from './openai-remote-compaction-transport.mjs';
import { requestStandardCompaction, StandardCompactionError } from './openai-standard-compaction.mjs';
import { makeV2WindowCandidate } from './openai-v2-window-candidate.mjs';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function validUserContent(content) {
  if (typeof content === 'string') return true;
  if (!Array.isArray(content)) return false;
  return content.every(part => {
    if (!isObject(part)) return false;
    if (part.type === 'input_text') return typeof part.text === 'string';
    if (part.type === 'input_image') return typeof part.image_url === 'string' || typeof part.file_id === 'string';
    if (part.type === 'input_file') return typeof part.file_id === 'string' || typeof part.file_data === 'string' || typeof part.file_url === 'string';
    return false;
  });
}

export function activeRemoteMarker(session) {
  const markers = session.surface.nodes.map(seq => session.eventAt(seq)).filter(event =>
    event?.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint' &&
    event.data?.content?.some(block => block?.type === 'text' && typeof block.text === 'string' && block.text.startsWith(REMOTE_MARKER)));
  if (markers.length > 1) throw new Error('Multiple remote checkpoints on the active surface');
  return markers[0];
}

/** Conservative structural check only. v2 semantic correctness relies on the
 * provider protocol; callers must not treat this as proof of decryptability. */
export function verifyRemoteOutput(output, identity) {
  if (!Array.isArray(output) || !output.length || !identity?.provider || !identity?.model || !identity?.backendId) return false;
  let count = 0;
  for (const item of output) {
    if (!isObject(item)) return false;
    if (item.type === 'compaction') {
      if (typeof item.encrypted_content !== 'string' || !item.encrypted_content.length) return false;
      count++;
    } else if ((item.type !== undefined && item.type !== 'message') || item.role !== 'user' || !validUserContent(item.content)) return false;
  }
  return count === 1;
}

/** Get an input view without rewriting the session. Already-rolled alpha windows
 * require a lossless local candidate; opaque/private items or unpaired tools are
 * rejected rather than silently treated as recovered progress. */
function selectedMessages(agent, start, end, sessions, needsRecovery) {
  const session = agent.session, nodes = session.surface.nodes;
  const a = nodes.indexOf(start), b = nodes.indexOf(end);
  if (a < 0 || b < a) throw new Error('Remote compaction selected range changed');
  if (needsRecovery) {
    let first = 0;
    while (first < nodes.length && session.eventAt(nodes[first])?.type === 'system/message') first++;
    if (first >= nodes.length || start !== nodes[first] || end !== nodes.at(-1))
      throw new Error('Recovery requires the complete active window');
    if (!Array.isArray(sessions.messageProjections)) throw new Error('Session message projections unavailable for recovery');
    const view = buildWindowRecoveryView({ events: session.snapshotEvents(), projections: sessions.messageProjections, inheritedEventCount: session.inheritedEventCount });
    if (!view.safeForAutomaticUse || view.diagnostics.length)
      throw new Error('Prior window requires manual recovery; opaque or incomplete history was retained');
    return view.entries.map(entry => entry.message);
  }
  const messages = [];
  const head = session.eventAt(nodes[0]);
  if (head?.type === 'system/message' && !nodes.slice(a, b + 1).includes(nodes[0])) {
    const message = session.deriveEventMessage(head); if (message) messages.push(message);
  }
  for (const seq of nodes.slice(a, b + 1)) {
    const message = session.deriveEventMessage(session.eventAt(seq)); if (message) messages.push(message);
  }
  return messages;
}

/** Compose exact snapshot serialization, provider-specific remote call, and a
 * replayable complete output. capture and identity validation must bind to the
 * authenticated, currently registered adapter; this function cannot establish
 * that by itself. No credentials or provider bodies are included in errors. */
export function makeRemotePrepare({ ctx, capture, validateCapture, transformAlphaInput, needsRecovery, openLease, fetch: fetcher }) {
  if (!ctx?.sessions || typeof capture !== 'function' || typeof validateCapture !== 'function' ||
      typeof transformAlphaInput !== 'function' || typeof needsRecovery !== 'function' || typeof openLease !== 'function' || typeof fetcher !== 'function')
    throw new Error('Remote preparation dependencies unavailable');
  return async function prepare({ agent, identity, start, end, signal }) {
    signal?.throwIfAborted();
    const lease = openLease({ agent, identity, signal });
    if (!lease || !(lease.signal instanceof AbortSignal) || typeof lease.check !== 'function' || typeof lease.dispose !== 'function')
      throw new Error('Remote compaction lease unavailable');
    const activeSignal = signal ? AbortSignal.any([signal, lease.signal]) : lease.signal;
    let stage = 'input';
    try {
    activeSignal.throwIfAborted();
    lease.check();
    const session = agent.session, oldRemote = activeRemoteMarker(session);
    const messages = selectedMessages(agent, start, end, ctx.sessions, !oldRemote && needsRecovery(agent));
    const header = session.requestHeader();
    const sameRoute = value => value?.provider === identity.provider && value?.model === identity.model;
    const base = sameRoute(header?.config) ? header.config : sameRoute(agent.options) ? agent.options : {};
    const controls = {};
    for (const key of ['reasoningEffort', 'temperature', 'maxTokens', 'stop'])
      if (base[key] !== undefined) controls[key] = base[key];
    const selection = agent.ctx?.get?.('sessionController')?.agents?.selectionFor?.(agent)?.current;
    if (sameRoute(selection)) {
      if (selection.reasoningEffort === undefined) delete controls.reasoningEffort;
      else controls.reasoningEffort = selection.reasoningEffort;
    }
    const options = { ...controls, provider: identity.provider, model: identity.model, sessionId: session.id, purpose: 'compaction', messages,
      toolHistory: session.toolHistory(), ...(header?.tools === undefined ? {} : { tools: [...header.tools] }), signal: activeSignal };
    stage = 'capture';
    const captured = await capture({ agent, identity, options, signal: activeSignal });
    activeSignal.throwIfAborted();
    lease.check(captured);
    if (!validateCapture(captured, identity) || !isObject(captured.payload) || !Array.isArray(captured.payload.input))
      throw new Error('Remote compaction transport identity unavailable');
    let payload = transformAlphaInput(captured.payload, agent);
    if (!isObject(payload) || !Array.isArray(payload.input)) throw new Error('Remote compaction input unavailable');
    if (oldRemote) payload = replayRemoteCheckpoint({ session, payload, identity, verifyCanonicalOutput: verifyRemoteOutput });
    activeSignal.throwIfAborted();
    lease.check(captured);
    let output;
    stage = 'request';
    if (captured.api === 'openai-responses') {
      ({ output } = await requestStandardCompaction({ endpoint: captured.url, headers: captured.headers, payload, fetch: fetcher, signal: activeSignal }));
    } else if (captured.api === 'openai-codex-responses') {
      const result = await requestRemoteCompaction({ endpoint: captured.url, headers: captured.headers, request: payload, fetch: fetcher, signal: activeSignal });
      output = makeV2WindowCandidate(payload.input, result.compactionOutput).output;
    } else throw new Error('Selected route has no remote compaction protocol');
    activeSignal.throwIfAborted();
    lease.check(captured);
    stage = 'verify';
    if (!verifyRemoteOutput(output, identity)) throw new Error('Remote compaction returned an unsafe output');
    return output;
    } catch (error) {
      if (error instanceof CheckpointError) throw error;
      // Only fixed phase labels, known error codes and HTTP status can enter
      // session diagnostics. Never persist exception text, bodies or headers.
      const knownCodes = new Set(['timeout', 'cancelled', 'http-error', 'transport-error', 'body-too-large', 'body-error', 'invalid-body', 'invalid-output', 'invalid-request', 'invalid-endpoint', 'missing-stream', 'missing-body', 'duplicate-compaction', 'invalid-compaction', 'missing-compaction', 'incomplete-response', 'invalid-event', 'event-too-large', 'too-many-events', 'stream-error', 'unexpected-output', 'event-limit', 'event-size-limit', 'stream-size-limit', 'invalid-stream', 'response-failed', 'response-incomplete', 'unexpected-output-item', 'invalid-completion', 'inconsistent-completion', 'invalid-utf8', 'unfinished-stream']);
      const knownTransport = error instanceof RemoteCompactionError || error instanceof StandardCompactionError;
      const code = knownTransport && knownCodes.has(error.code) ? error.code : 'failed';
      const status = knownTransport && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? `-${error.status}` : '';
      throw new CheckpointError(`prepare-${stage}-${code}${status}`);
    } finally { lease.dispose(); }
  };
}

/** Conservatively account for the expanded prior opaque checkpoint rather than
 * pricing only its short marker. Real provider tokenization is not observable. */
export function extraRemoteCheckpointTokens(agent, identity) {
  const session = agent.session, marker = activeRemoteMarker(session);
  if (!marker) return 0;
  const text = marker.data.content[0]?.text;
  if (typeof text !== 'string') throw new Error('Invalid remote checkpoint marker');
  const payload = replayRemoteCheckpoint({ session, identity, verifyCanonicalOutput: verifyRemoteOutput,
    payload: { input: [{ role: 'user', content: [{ type: 'input_text', text }] }] } });
  return Math.max(0, Math.ceil(Buffer.byteLength(JSON.stringify(payload.input), 'utf8') / 4) - Math.floor(Buffer.byteLength(text, 'utf8') / 4));
}
