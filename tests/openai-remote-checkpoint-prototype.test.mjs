import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, buildForkSeed } from '@deepseek-ai/dsh-session';
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm';
import { commitRemoteCheckpoint, replayRemoteCheckpoint, REMOTE_MARKER } from '../src/openai-remote-checkpoint-prototype.mjs';

const identity = { provider: 'openai-codex', model: 'gpt-x', backendId: 'opaque-endpoint-account' };
// A test-only verifier. Production MUST prove the output is a complete canonical window.
const verify = (output, id) => Array.isArray(output) && output.length === 2 && id.backendId === identity.backendId;
const canonical = [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'preserved' }] },
  { type: 'compaction', encrypted_content: 'secret-ciphertext' },
];
const user = (text) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const add = (s, text) => s.append('user/message', user(text), { surfaceOp: 'append' }).seq;
const options = (session, start, end, overrides = {}) => ({ session, start, end, identity, prepare: async () => structuredClone(canonical), verifyCanonicalOutput: verify, flush: async () => {}, ...overrides });
const hasCode = (expected, replaced = false) => (e) => { assert.equal(e.code, expected); assert.equal(e.replaced, replaced); return true; };
const markerItem = (s) => ({ role: 'user', content: [{ type: 'input_text', text: s.eventAt(s.surface.nodes.find(seq => s.eventAt(seq)?.data?.source?.kind === 'compact-checkpoint')).data.content[0].text }] });
const replay = (session, payload, opts = {}) => replayRemoteCheckpoint({ session, payload, identity, verifyCanonicalOutput: verify, ...opts });

async function committed() {
  const session = Session.create('parent'); const a = add(session, 'before-a'); const b = add(session, 'before-b');
  let durable;
  const result = await commitRemoteCheckpoint(options(session, a, b, { flush: async s => { durable = s.snapshotEvents(); } }));
  return { session, result, durable };
}

test('real Session stores adjacent summary/marker with complete sources and restores output in place', async () => {
  const { session, result, durable } = await committed();
  assert.equal(result.durable, true);
  const events = session.snapshotEvents(), marker = session.eventAt(session.surface.nodes[0]), summary = events[marker.seq - 1];
  assert.equal(summary.type, 'compaction/summary');
  assert.ok(summary.data.summary[0].text.includes('secret-ciphertext'));
  assert.ok(marker.data.content[0].text.startsWith(REMOTE_MARKER));
  assert.ok(!JSON.stringify(marker).includes('secret-ciphertext'));
  assert.deepEqual(marker.sourceEventSeqs, [events.find(e => e.type === 'compaction/start').seq, summary.seq, ...summary.data.shadowedSeqs]);
  assert.equal(events[marker.seq + 1].type, 'compaction/end');
  assert.equal(result.startSeq, events.find(e => e.type === 'compaction/start').seq);
  assert.equal(result.summarySeq, summary.seq);
  assert.equal(result.endSeq, events[marker.seq + 1].seq);
  assert.equal(result.compactionId, marker.data.source.compactionId);
  assert.deepEqual(result.summary, marker.data.content);
  assert.deepEqual(result.shadowedRange, summary.data.shadowedRange);
  assert.deepEqual(result.shadowedSeqs, summary.data.shadowedSeqs);
  assert.equal(result.shadowedSeqs.length, 2); // Basic pre-step listener contract
  assert.equal(result.shadowedTokenCount, summary.data.shadowedTokenCount);
  assert.equal(result.replaced, true);
  assert.ok(!JSON.stringify(result).includes('secret-ciphertext'));
  add(session, 'tail');
  const before = { model: 'gpt-x', input: [{ role: 'developer', content: [{ type: 'input_text', text: 'prefix' }] }, markerItem(session), { role: 'user', content: [{ type: 'input_text', text: 'tail' }] }] };
  const copy = structuredClone(before);
  const after = replay(session, before);
  assert.deepEqual(after.input, [before.input[0], ...canonical, before.input[2]]);
  assert.deepEqual(before, copy);
  const restored = Session.create('parent', durable, session.header);
  assert.deepEqual(replay(restored, { input: [markerItem(restored)] }).input, canonical);
});

test('failed verifier, cancellation, and changed surface keep old nodes and close the lock', async () => {
  for (const scenario of ['unverified', 'cancel', 'changed']) {
    const s = Session.create('s'); const a = add(s, 'a'); const b = add(s, 'b');
    const c = new AbortController(); let flushCount = 0;
    const promise = commitRemoteCheckpoint(options(s, a, b, {
      signal: c.signal,
      flush: async () => { flushCount++; },
      verifyCanonicalOutput: scenario === 'unverified' ? () => false : verify,
      prepare: async () => { if (scenario === 'cancel') c.abort(); if (scenario === 'changed') add(s, 'later'); return structuredClone(canonical); },
    }));
    await assert.rejects(promise, hasCode({ unverified: 'canonical-output-unverified', cancel: 'cancelled', changed: 'surface-changed' }[scenario]));
    assert.deepEqual(s.surface.nodes.slice(0, 2), [a, b]);
    assert.equal(s.snapshotEvents().at(-1).type, 'compaction/end');
    assert.equal(flushCount, 1);
  }
});

test('busy lock and incomplete tool boundary fail before start', async () => {
  const busy = Session.create('s'); const a = add(busy, 'a');
  busy.append('compaction/start', { compactionId: 'active', turn: null });
  const before = busy.seq;
  await assert.rejects(commitRemoteCheckpoint(options(busy, a, a)), hasCode('busy'));
  assert.equal(busy.seq, before);
  const s = Session.create('s2');
  s.append('turn/start', { turn: 1 }); s.append('step/start', { turn: 1, step: 1 });
  const call = s.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ source: { provider: 'openai', model: 'gpt-x' }, content: [{ type: 'tool-call', id: 'c', name: 'read', arguments: '{}' }] }) }, { surfaceOp: 'append' }).seq;
  await assert.rejects(commitRemoteCheckpoint(options(s, call, call, { mode: 'automatic' })), hasCode('unbalanced-range'));
  assert.ok(!s.snapshotEvents().some(e => e.type === 'compaction/start'));
});

test('flush failure after replacement reports replaced=true, never an uncommitted result', async () => {
  const s = Session.create('s'), a = add(s, 'a');
  await assert.rejects(commitRemoteCheckpoint(options(s, a, a, { flush: async () => { throw Error('secret'); } })), hasCode('flush-failed', true));
  assert.equal(s.eventAt(s.surface.nodes[0]).data.source.kind, 'compact-checkpoint');
  assert.equal(s.snapshotEvents().at(-1).type, 'compaction/end');
});

test('post-replacement cancellation is not mistaken for an uncommitted attempt', async () => {
  const s = Session.create('s'), a = add(s, 'a'); const c = new AbortController();
  await assert.rejects(commitRemoteCheckpoint(options(s, a, a, { signal: c.signal, flush: async () => c.abort() })), hasCode('cancelled', true));
  assert.equal(s.eventAt(s.surface.nodes[0]).data.source.kind, 'compact-checkpoint');
});

test('replay refuses mismatch, missing or ambiguous payload markers, and partial log records', async () => {
  const { session: s } = await committed(), marker = markerItem(s);
  assert.throws(() => replay(s, { input: [marker] }, { identity: { ...identity, backendId: 'other' } }), hasCode('identity-mismatch'));
  assert.throws(() => replay(s, { input: [] }), hasCode('missing-or-duplicate-payload-marker'));
  assert.throws(() => replay(s, { input: [marker, marker] }), hasCode('missing-or-duplicate-payload-marker'));
  assert.throws(() => replay(s, { input: [{ role: 'user', content: [{ ...marker.content[0], text: `prefix ${marker.content[0].text}` }] }] }), hasCode('invalid-payload-marker'));
  assert.throws(() => replay(s, { input: [marker] }, { verifyCanonicalOutput: () => false }), hasCode('canonical-output-unverified'));
  const markerSeq = s.surface.nodes[0];
  const fake = { surface: s.surface, eventAt: s.eventAt.bind(s), snapshotEvents: () => s.snapshotEvents().map(e => e.seq === markerSeq - 1 ? { ...e, type: 'turn/start' } : e) };
  assert.throws(() => replay(fake, { input: [marker] }), hasCode('missing-record'));
});

test('manual command identity survives transaction, replay, and real fork', async () => {
  const parent = Session.create('parent-command');
  const a = add(parent, 'a');
  const result = await commitRemoteCheckpoint(options(parent, a, a, { sourceCommandId: 'command-compact-123', shadowedTokenCount: 321 }));
  assert.equal(result.sourceCommandId, 'command-compact-123');
  assert.equal(result.shadowedTokenCount, 321);
  assert.deepEqual(result.shadowedSeqs, [a]);
  assert.deepEqual(result.shadowedRange, { start: a, end: a });
  const marker = parent.eventAt(parent.surface.nodes[0]);
  const events = parent.snapshotEvents();
  for (const event of [events.find(e => e.type === 'compaction/start'), events[marker.seq - 1], events[marker.seq + 1]])
    assert.equal(event.data.sourceCommandId, 'command-compact-123');
  assert.equal(marker.data.source.sourceCommandId, 'command-compact-123');
  assert.deepEqual(replay(parent, { input: [markerItem(parent)] }).input, canonical);
  const boundary = parent.seq - 1;
  const child = Session.create('child-command', buildForkSeed(parent.snapshotEvents(), boundary), { ...parent.header, id: 'child-command', isSeeded: true }, boundary + 1);
  assert.deepEqual(replay(child, { input: [markerItem(child)] }).input, canonical);
  assert.equal(child.eventAt(child.surface.nodes[0]).data.source.sourceCommandId, 'command-compact-123');
});

test('actual fork carries full record, while fork at pre-end boundary fails closed', async () => {
  const { session: parent } = await committed(); const markerSeq = parent.surface.nodes[0];
  const boundary = parent.seq - 1;
  const seed = buildForkSeed(parent.snapshotEvents(), boundary);
  const child = Session.create('child', seed, { ...parent.header, id: 'child', isSeeded: true }, boundary + 1);
  add(child, 'child-tail');
  assert.deepEqual(replay(child, { input: [markerItem(child), { role: 'user', content: [{ type: 'input_text', text: 'child-tail' }] }] }).input, [...canonical, { role: 'user', content: [{ type: 'input_text', text: 'child-tail' }] }]);
  const truncatedSeed = buildForkSeed(parent.snapshotEvents(), markerSeq);
  const truncated = Session.create('truncated', truncatedSeed, { ...parent.header, id: 'truncated', isSeeded: true }, markerSeq + 1);
  assert.throws(() => replay(truncated, { input: [markerItem(truncated)] }), hasCode('invalid-transaction'));
});
