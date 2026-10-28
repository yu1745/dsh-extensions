import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { compactCheckpointSource, toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';

// This helper is not wired into a plugin. A caller MUST independently establish
// that canonicalOutput is the complete provider replacement window. In particular,
// one v2 compaction item alone is not evidence of canonical completeness.
export const REMOTE_MARKER = '<dsh-remote-compaction-v1>';
const RECORD = '<dsh-remote-compaction-record-v1>';
const hash = (text) => createHash('sha256').update(text).digest('hex');
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bad = (code, replaced = false) => { throw new CheckpointError(code, replaced); };
export class CheckpointError extends Error {
  constructor(code, replaced = false) {
    super(`remote checkpoint: ${code}`);
    this.name = 'CheckpointError'; this.code = code; this.replaced = replaced;
  }
}
function validateIdentity(identity) {
  if (!isObject(identity) || Object.keys(identity).sort().join(',') !== 'backendId,model,provider' ||
      !['backendId', 'provider', 'model'].every(k => typeof identity[k] === 'string' && identity[k].trim())) bad('invalid-identity');
}
function validateRecord(record, verifyCanonicalOutput) {
  if (!isObject(record) || record.version !== 1 || typeof record.compactionId !== 'string' || !record.compactionId ||
      !Array.isArray(record.output) || record.output.length === 0 || !record.output.every(isObject) ||
      typeof verifyCanonicalOutput !== 'function') bad('invalid-record');
  validateIdentity(record.identity);
  // The external verifier is a required trust boundary, not a claim about v2.
  let verified = false;
  try { verified = verifyCanonicalOutput(structuredClone(record.output), structuredClone(record.identity)) === true; } catch {}
  if (!verified) bad('canonical-output-unverified');
}
function lockOwner(session) {
  let owner = null;
  for (const e of session.snapshotEvents()) {
    if (e.type === 'session/end-seed') owner = null;
    else if (e.type === 'compaction/start') {
      if (owner !== null) bad('invalid-lock-history');
      owner = e.data.compactionId;
    } else if (e.type === 'compaction/end') {
      if (owner !== e.data.compactionId) bad('invalid-lock-history');
      owner = null;
    }
  }
  return owner;
}
function activeTurn(events) {
  let turn = null;
  for (const event of events) {
    if (event.type === 'turn/start') {
      if (turn !== null || !Number.isSafeInteger(event.data.turn) || event.data.turn < 0) bad('invalid-turn-history');
      turn = event.data.turn;
    } else if (event.type === 'turn/end') {
      if (turn === null || event.data.turn !== turn) bad('invalid-turn-history');
      turn = null;
    }
  }
  return turn;
}
function range(session, start, end) {
  const surface = session.surface;
  const { contentGeneration, replaceGeneration } = surface;
  if (!Number.isSafeInteger(contentGeneration) || contentGeneration < 0 || !Number.isSafeInteger(replaceGeneration) || replaceGeneration < 0) bad('invalid-surface-generation');
  const nodes = [...surface.nodes], a = nodes.indexOf(start), b = nodes.indexOf(end);
  if (a < 0 || b < a) bad('invalid-range');
  if (!toolPairingBalancedBefore(session, start) || !toolPairingBalancedAfter(session, end)) bad('unbalanced-range');
  return { nodes, shadowed: nodes.slice(a, b + 1), contentGeneration, replaceGeneration };
}
function surfaceUnchanged(session, selected) {
  const surface = session.surface;
  return surface.contentGeneration === selected.contentGeneration && surface.replaceGeneration === selected.replaceGeneration &&
    same([...surface.nodes], selected.nodes);
}
function hasRemoteMarker(event) {
  return event?.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint' &&
    event.data?.content?.some(block => block?.type === 'text' && typeof block.text === 'string' && block.text.startsWith(REMOTE_MARKER));
}
function checkCancelled(signal) { if (signal?.aborted) bad('cancelled'); }

/** Append-only DSH transaction. `prepare` may perform work but must not mutate
 * session; `flush` must durably flush the actual SessionStore writer. A detached
 * Session and a no-op flush do not provide crash durability. Manual mode requires
 * an idle turn; automatic mode requires an open turn and records its turn number.
 * `replaced` on any error distinguishes a visible replacement from a pre-commit failure.
 */
export async function commitRemoteCheckpoint({ session, start, end, identity, prepare, verifyCanonicalOutput, flush, signal, sourceCommandId, mode = 'manual', shadowedTokenCount = 0 }) {
  validateIdentity(identity);
  if (sourceCommandId !== undefined && (typeof sourceCommandId !== 'string' || !sourceCommandId.trim())) bad('invalid-source-command-id');
  if (typeof prepare !== 'function' || typeof flush !== 'function' || typeof verifyCanonicalOutput !== 'function') bad('invalid-dependencies');
  if (!Number.isSafeInteger(shadowedTokenCount) || shadowedTokenCount < 0) bad('invalid-price');
  checkCancelled(signal);
  if (lockOwner(session) !== null) bad('busy');
  if (mode !== 'manual' && mode !== 'automatic') bad('invalid-mode');
  const turn = activeTurn(session.snapshotEvents());
  if (mode === 'manual' && turn !== null) bad('turn-busy');
  if (mode === 'automatic' && turn === null) bad('no-open-turn');
  const selected = range(session, start, end);
  // Do not leave an older remote marker outside this replacement range.
  for (const seq of selected.nodes) if (hasRemoteMarker(session.eventAt(seq)) && !selected.shadowed.includes(seq)) bad('multiple-checkpoints');
  const compactionId = randomUUID();
  const lifecycle = { compactionId, turn, ...(sourceCommandId === undefined ? {} : { sourceCommandId }) };
  const startEvent = session.append('compaction/start', lifecycle);
  const ownerUnchanged = () => activeTurn(session.snapshotEvents()) === turn &&
    !session.snapshotEvents(startEvent.seq + 1).some(e => e.type === 'turn/start' || e.type === 'turn/end' || e.type === 'session/end-seed');
  let replaced = false, closed = false, failure, result;
  try {
    const output = await prepare(signal);
    checkCancelled(signal);
    if (!ownerUnchanged()) bad('turn-changed');
    if (lockOwner(session) !== compactionId || !surfaceUnchanged(session, selected)) bad('surface-changed');
    const record = { version: 1, compactionId, identity: structuredClone(identity), output };
    validateRecord(record, verifyCanonicalOutput);
    checkCancelled(signal);
    if (!ownerUnchanged()) bad('turn-changed');
    if (lockOwner(session) !== compactionId || !surfaceUnchanged(session, selected)) bad('surface-changed');
    // Canonical JSON is exactly the stored text; hash covers identity and all output.
    let text;
    try {
      const encoded = JSON.stringify(record);
      if (!isDeepStrictEqual(JSON.parse(encoded), record)) bad('invalid-record');
      text = RECORD + encoded;
    } catch { bad('invalid-record'); }
    // Verify no callback mutated the surface or lock, and recheck balanced edges.
    checkCancelled(signal);
    if (!ownerUnchanged()) bad('turn-changed');
    if (lockOwner(session) !== compactionId || !surfaceUnchanged(session, selected)) bad('surface-changed');
    range(session, start, end);
    const marker = REMOTE_MARKER + JSON.stringify({ version: 1, compactionId, sha256: hash(text) });
    const summary = session.append('compaction/summary', {
      compactionId, ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
      summary: [{ type: 'text', text }], provider: identity.provider, model: identity.model,
      shadowedRange: { start, end }, shadowedSeqs: selected.shadowed, shadowedTokenCount,
    });
    // This must remain immediately adjacent to the summary event.
    session.append('user/message', createUserMessage({ source: compactCheckpointSource(compactionId, sourceCommandId), content: [{ type: 'text', text: marker }] }), {
      surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
      sourceEventSeqs: [startEvent.seq, summary.seq, ...selected.shadowed],
    });
    replaced = true;
    const endEvent = session.append('compaction/end', lifecycle); closed = true;
    result = {
      compactionId, ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
      startSeq: startEvent.seq, summarySeq: summary.seq, endSeq: endEvent.seq,
      summary: [{ type: 'text', text: marker }],
      shadowedRange: { start, end }, shadowedSeqs: [...selected.shadowed], shadowedTokenCount,
      replaced: true, durable: true,
    };
  } catch (error) {
    failure = error instanceof CheckpointError ? error.code : 'transaction-failed';
    if (!closed) {
      try {
        // Never manufacture a close marker outside the original turn or lock.
        if (!ownerUnchanged() || lockOwner(session) !== compactionId) failure = 'turn-or-lock-changed';
        else { session.append('compaction/end', { ...lifecycle, ...(replaced ? {} : { error: failure }) }); closed = true; }
      } catch { failure = 'close-failed'; }
    }
  }
  // Flush after every accepted start, regardless of success or cancellation.
  try { await flush(session); } catch { bad('flush-failed', replaced); }
  if (failure) bad(failure, replaced);
  if (signal?.aborted) bad('cancelled', replaced);
  if (!result) bad('missing-result', replaced);
  return result;
}

function readRecord(session, markerEvent, verifyCanonicalOutput, identity) {
  const blocks = markerEvent.data.content;
  if (blocks.length !== 1 || blocks[0]?.type !== 'text' || typeof blocks[0].text !== 'string') bad('invalid-marker');
  const markerText = blocks[0].text;
  let marker;
  try { marker = JSON.parse(markerText.slice(REMOTE_MARKER.length)); } catch { bad('invalid-marker'); }
  if (!isObject(marker) || Object.keys(marker).sort().join(',') !== 'compactionId,sha256,version' || marker.version !== 1 ||
      typeof marker.compactionId !== 'string' || !/^[a-f0-9]{64}$/.test(marker.sha256) ||
      markerEvent.data.source?.compactionId !== marker.compactionId) bad('invalid-marker');
  const events = session.snapshotEvents();
  const summary = events[markerEvent.seq - 1];
  if (summary?.type !== 'compaction/summary' || summary.data.compactionId !== marker.compactionId ||
      !Array.isArray(summary.data.summary) || summary.data.summary.length !== 1 || summary.data.summary[0]?.type !== 'text') bad('missing-record');
  const text = summary.data.summary[0].text;
  if (typeof text !== 'string' || !text.startsWith(RECORD) || hash(text) !== marker.sha256) bad('record-mismatch');
  let record;
  try { record = JSON.parse(text.slice(RECORD.length)); } catch { bad('invalid-record'); }
  if (record.compactionId !== marker.compactionId || !isDeepStrictEqual(record.identity, identity)) bad('identity-mismatch');
  validateRecord(record, verifyCanonicalOutput);
  const startEvents = events.filter(e => e.type === 'compaction/start' && e.data.compactionId === marker.compactionId);
  const end = events[markerEvent.seq + 1];
  const shadowed = summary.data.shadowedSeqs;
  if (startEvents.length !== 1 || startEvents[0].seq >= summary.seq ||
      events.filter(e => e.type === 'compaction/summary' && e.data.compactionId === marker.compactionId).length !== 1 ||
      end?.type !== 'compaction/end' || end.data.compactionId !== marker.compactionId || end.data.error ||
      !Array.isArray(shadowed) || shadowed.length === 0 || new Set(shadowed).size !== shadowed.length ||
      shadowed[0] !== summary.data.shadowedRange?.start || shadowed.at(-1) !== summary.data.shadowedRange?.end ||
      !same(markerEvent.sourceEventSeqs, [startEvents[0].seq, summary.seq, ...shadowed]) ||
      markerEvent.surfaceOp?.op !== 'replace' || markerEvent.surfaceOp.startSeq !== summary.data.shadowedRange?.start ||
      markerEvent.surfaceOp.endSeq !== summary.data.shadowedRange?.end ||
      summary.data.provider !== identity.provider || summary.data.model !== identity.model) bad('invalid-transaction');
  const sourceCommandId = startEvents[0].data.sourceCommandId;
  if ((sourceCommandId !== undefined && (typeof sourceCommandId !== 'string' || !sourceCommandId.trim())) ||
      summary.data.sourceCommandId !== sourceCommandId || markerEvent.data.source.sourceCommandId !== sourceCommandId ||
      end.data.sourceCommandId !== sourceCommandId) bad('invalid-transaction');
  try {
    const openTurn = activeTurn(events.slice(0, startEvents[0].seq));
    if (startEvents[0].data.turn !== openTurn || end.data.turn !== openTurn ||
        events.slice(startEvents[0].seq + 1, end.seq).some(e => e.type === 'turn/start' || e.type === 'turn/end' || e.type === 'session/end-seed')) bad('invalid-transaction');
  } catch { bad('invalid-transaction'); }
  return { markerText, output: record.output };
}

/** Replace exactly one surface checkpoint marker in a Responses payload in place.
 * No substitutions into user text, no silent fallback, and input after the marker
 * remains in the same order. Forks are valid only if their inherited log includes
 * the entire referenced transaction and identity matches.
 */
export function replayRemoteCheckpoint({ session, payload, identity, verifyCanonicalOutput }) {
  validateIdentity(identity);
  if (!isObject(payload) || !Array.isArray(payload.input)) bad('invalid-payload');
  const markers = session.surface.nodes.map(seq => session.eventAt(seq)).filter(hasRemoteMarker);
  if (markers.length !== 1) bad('missing-or-duplicate-marker');
  const { markerText, output } = readRecord(session, markers[0], verifyCanonicalOutput, identity);
  const matches = [];
  for (let i = 0; i < payload.input.length; i++) {
    const item = payload.input[i];
    if (!isObject(item) || !Array.isArray(item.content)) continue;
    for (const block of item.content) if (typeof block?.text === 'string' && block.text.includes(REMOTE_MARKER)) {
      if (item.role !== 'user' || item.content.length !== 1 || block.type !== 'input_text' || block.text !== markerText) bad('invalid-payload-marker');
      matches.push(i);
    }
  }
  if (matches.length !== 1) bad('missing-or-duplicate-payload-marker');
  const result = structuredClone(payload);
  result.input.splice(matches[0], 1, ...structuredClone(output));
  return result;
}
