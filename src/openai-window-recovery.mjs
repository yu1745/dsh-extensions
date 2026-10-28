import { deriveEventMessage, foldSurface } from '@deepseek-ai/dsh-session';

// This is an offline, read-only candidate view, NOT a valid session, seed,
// request, recovery transaction, or proof that all original content is readable.
const MARKER = '<dsh-openai-window>';

function markerKind(event) {
  if (event?.type !== 'user/message' || event.data?.source?.kind !== 'compact-checkpoint') return 'none';
  const markers = (event.data.content ?? []).filter((block) =>
    block?.type === 'text' && typeof block.text === 'string' && block.text.startsWith(MARKER));
  if (!markers.length) return 'compact';
  if (markers.length !== 1) throw new Error(`Ambiguous window marker at seq ${event.seq}`);
  let marker;
  try { marker = JSON.parse(markers[0].text.slice(MARKER.length)); }
  catch { throw new Error(`Invalid window marker at seq ${event.seq}`); }
  if (marker?.version !== 1 || typeof marker.windowId !== 'string' || typeof marker.sessionId !== 'string')
    throw new Error(`Unsupported window marker at seq ${event.seq}`);
  return 'window';
}

/** Expand only window replacement nodes in surface order; reject malformed graphs. */
export function expandWindowNodes(nodes, replacements, events) {
  const bySeq = new Map();
  for (const replacement of replacements) {
    if (bySeq.has(replacement.seq)) throw new Error(`Duplicate replacement seq ${replacement.seq}`);
    bySeq.set(replacement.seq, replacement);
  }
  const seen = new Set();
  const active = new Set();
  const result = [];
  const stack = [...nodes].reverse().map((seq) => ({ seq, exit: false }));
  while (stack.length) {
    const { seq, exit } = stack.pop();
    if (exit) { active.delete(seq); continue; }
    if (!Number.isSafeInteger(seq) || seq < 0 || seq >= events.length || events[seq]?.seq !== seq)
      throw new Error(`Missing or out-of-range event seq ${seq}`);
    if (active.has(seq)) throw new Error(`Cycle in window replacement graph at seq ${seq}`);
    if (seen.has(seq)) throw new Error(`Duplicate event seq ${seq} in recovery view`);
    seen.add(seq);
    const replacement = bySeq.get(seq);
    if (markerKind(events[seq]) !== 'window') { result.push(seq); continue; }
    if (!replacement || !Array.isArray(replacement.shadowedSeqs) || !replacement.shadowedSeqs.length)
      throw new Error(`Window marker at seq ${seq} has no replacement history`);
    active.add(seq);
    stack.push({ seq, exit: true });
    for (let i = replacement.shadowedSeqs.length - 1; i >= 0; i--)
      stack.push({ seq: replacement.shadowedSeqs[i], exit: false });
  }
  return result;
}

// Private tool calls/outputs might contain ciphertext even if their JSON shape
// resembles plain text. Never return ciphertext or tool arguments in diagnostics.
function isPrivateTool(name) {
  return typeof name === 'string' && /^(?:notes|history)(?:_|\.)/.test(name);
}
function hasCiphertext(value) {
  const stack = [value], seen = new Set();
  while (stack.length) {
    const item = stack.pop();
    if (typeof item === 'string') {
      if (item.length <= 1_000_000 && item.startsWith('{')) {
        try { const parsed = JSON.parse(item); if (parsed && typeof parsed === 'object') stack.push(parsed); } catch {}
      }
      continue;
    }
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    if (typeof item.encrypted_output === 'string' || typeof item.encrypted_content === 'string' || item.type === 'encrypted_content') return true;
    stack.push(...Object.values(item));
  }
  return false;
}

/**
 * Produce a detached candidate view from exactly one session snapshot prefix.
 * `boundary` is an inclusive seq, not a request to read a parent session.
 * `inheritedEventCount`, if supplied, belongs to this snapshot. The caller is
 * responsible for obtaining the correct fork lineage and projection definitions.
 * Throws on malformed histories; diagnostics are conservative and incomplete.
 */
export function buildWindowRecoveryView({ events, projections = [], boundary, inheritedEventCount }) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  // A fork may itself inherit an earlier fork marker. The last inherited marker
  // identifies this child's cut; it does not prove the snapshot's lineage.
  let inheritedMarker = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i]?.type === 'session/end-seed' && events[i]?.data?.inherited === true) inheritedMarker = i;
  }
  const expectedInherited = inheritedMarker < 0 ? 0 : inheritedMarker;
  if (inheritedEventCount === undefined) inheritedEventCount = expectedInherited;
  if (!Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0 || inheritedEventCount > events.length || inheritedEventCount !== expectedInherited)
    throw new Error('Invalid inherited event count or missing fork marker');
  const end = boundary === undefined ? events.length - 1 : boundary;
  if (!Number.isSafeInteger(end) || end < -1 || end >= events.length || (end === -1 && events.length !== 0))
    throw new Error('Invalid inclusive boundary');
  // Do not let caller-provided projections mutate the caller's snapshot.
  const snapshot = structuredClone(events.slice(0, end + 1));
  const folded = foldSurface(snapshot, projections);
  const selected = expandWindowNodes(folded.nodes, folded.replacements, snapshot);
  const replacements = new Map(folded.replacements.map((r) => [r.seq, r]));
  const diagnostics = [];
  const pending = new Map();
  const entries = [];

  // Search non-window compaction descendants for hidden earlier window markers,
  // without expanding that compaction into the returned candidate view.
  function hiddenWindows(seq) {
    const visited = new Set(), todo = [...(replacements.get(seq)?.shadowedSeqs ?? [])];
    let count = 0;
    while (todo.length) {
      const child = todo.pop();
      if (!Number.isSafeInteger(child) || child < 0 || child >= snapshot.length || snapshot[child]?.seq !== child)
        throw new Error(`Missing or out-of-range hidden event seq ${child}`);
      if (visited.has(child)) throw new Error(`Duplicate or cyclic hidden replacement seq ${child}`);
      visited.add(child);
      if (markerKind(snapshot[child]) === 'window') count++;
      const next = replacements.get(child);
      if (next) todo.push(...next.shadowedSeqs);
    }
    return count;
  }
  for (const seq of selected) {
    const event = snapshot[seq];
    if (markerKind(event) === 'compact') {
      diagnostics.push({ code: 'non-window-compaction', seq, hiddenWindowMarkers: hiddenWindows(seq) });
    } else if (replacements.has(seq)) {
      const count = hiddenWindows(seq);
      if (count) diagnostics.push({ code: 'non-window-replacement-hides-window', seq, hiddenWindowMarkers: count });
    }
    const message = deriveEventMessage(event, folded.projectedMessages);
    if (!message) continue;
    entries.push({ seq, type: event.type, inherited: seq < inheritedEventCount, message });
    if (hasCiphertext(message)) diagnostics.push({ code: 'opaque-encrypted-content', seq });
    if (message.source?.replayState !== undefined) diagnostics.push({ code: 'opaque-provider-replay-state', seq });
    if (message.role === 'assistant') {
      for (const block of message.content ?? []) {
        if (block?.type !== 'tool-call') continue;
        const id = block.id;
        if (isPrivateTool(block.name)) diagnostics.push({ code: 'private-remote-tool', seq, name: block.name });
        if (typeof id !== 'string' || !id) diagnostics.push({ code: 'missing-tool-call-id', seq });
        else if (pending.has(id)) diagnostics.push({ code: 'duplicate-open-tool-call-id', seq, callId: id });
        else pending.set(id, { seq, name: block.name });
      }
    } else if (message.role === 'tool') {
      const id = message.toolCallId;
      if (typeof id !== 'string' || !pending.has(id)) diagnostics.push({ code: 'unmatched-tool-result', seq, callId: typeof id === 'string' ? id : null });
      else {
        const call = pending.get(id);
        if (isPrivateTool(call.name)) diagnostics.push({ code: 'private-remote-tool-result', seq, name: call.name });
        pending.delete(id);
      }
    }
  }
  for (const [callId, call] of pending) diagnostics.push({ code: 'missing-tool-result', seq: call.seq, callId });
  return {
    kind: 'candidate-only',
    safeForAutomaticUse: false,
    boundary: end,
    inheritedEventCount: Math.min(inheritedEventCount, snapshot.length),
    entries,
    diagnostics,
    limitations: [
      'Candidate only: not a session seed, model request, or durable recovery.',
      'Opaque remote notes, history, ciphertext, provider state, and unavailable attachments cannot be recovered by this view.',
      'The caller must verify fork lineage, projections, privacy, tool pairing, and all omissions before any use.',
    ],
  };
}
