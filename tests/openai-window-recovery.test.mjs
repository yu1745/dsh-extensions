import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, buildForkSeed } from '@deepseek-ai/dsh-session';
import { createUserMessage, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { buildWindowRecoveryView, expandWindowNodes } from '../src/openai-window-recovery.mjs';

const marker = '<dsh-openai-window>' + JSON.stringify({ version: 1, windowId: 'w', sessionId: 's' });
const plain = (text, source = { kind: 'user' }) => createUserMessage({ source, content: [{ type: 'text', text }] });
const add = (s, text) => s.append('user/message', plain(text), { surfaceOp: 'append' }).seq;
function replace(s, start, end, text = marker, source = { kind: 'compact-checkpoint', compactionId: 'c' }) {
  const nodes = s.surface.nodes;
  const shadowed = nodes.slice(nodes.indexOf(start), nodes.indexOf(end) + 1);
  return s.append('user/message', plain(text, source), {
    surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: shadowed,
  }).seq;
}
function assistant(s, calls) {
  return s.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
    source: { provider: 'openai', model: 'gpt-x' },
    content: calls.map(([id, name]) => ({ type: 'tool-call', id, name, arguments: '{}' })),
  }) }, { surfaceOp: 'append' }).seq;
}
function result(s, callId, text = 'ok', isError = false) {
  return s.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
    callId, content: [{ type: 'text', text }], isError,
  }) }, { surfaceOp: 'append' }).seq;
}
const view = (s, options = {}) => buildWindowRecoveryView({ events: s.snapshotEvents(), ...options });

 test('nested windows preserve surface order, not numeric sequence order', () => {
  const s = Session.create('s');
  const a = add(s, 'a'), b = add(s, 'b');
  const unrelated = replace(s, a, a, 'ordinary replacement', { kind: 'system-prompt' });
  const first = replace(s, unrelated, b);
  const c = add(s, 'c');
  replace(s, first, c);
  const before = JSON.stringify(s.snapshotEvents());
  const recovered = view(s);
  assert.deepEqual(recovered.entries.map((x) => x.seq), [unrelated, b, c]);
  assert.notDeepEqual(recovered.entries.map((x) => x.seq), [...recovered.entries.map((x) => x.seq)].sort((x, y) => x - y));
  assert.equal(recovered.kind, 'candidate-only');
  assert.equal(recovered.safeForAutomaticUse, false);
  assert.equal(JSON.stringify(s.snapshotEvents()), before);
});

test('non-window compaction remains intact and hidden window is reported', () => {
  const s = Session.create('s');
  const a = add(s, 'original'), w = replace(s, a, a);
  const b = add(s, 'later');
  const compact = replace(s, w, b, 'ordinary summary');
  const tail = add(s, 'tail');
  const result = view(s);
  assert.deepEqual(result.entries.map((x) => x.seq), [compact, tail]);
  assert.deepEqual(result.diagnostics, [{ code: 'non-window-compaction', seq: compact, hiddenWindowMarkers: 1 }]);
});

test('other replacement hiding a window stays opaque with a diagnostic', () => {
  const s = Session.create('s');
  const a = add(s, 'a'), w = replace(s, a, a);
  const other = replace(s, w, w, 'not a checkpoint', { kind: 'system-prompt' });
  const v = view(s);
  assert.deepEqual(v.entries.map((e) => e.seq), [other]);
  assert.equal(v.diagnostics[0].code, 'non-window-replacement-hides-window');
});

test('reject missing, duplicate, cyclic and missing replacement graph nodes', () => {
  const ev = [0, 1, 2].map((seq) => ({ seq, type: 'user/message', data: plain(seq === 0 ? 'leaf' : marker, { kind: 'compact-checkpoint', compactionId: 'x' }) }));
  assert.throws(() => expandWindowNodes([2], [{ seq: 2, shadowedSeqs: [3] }], ev), /out-of-range/);
  assert.throws(() => expandWindowNodes([2], [{ seq: 2, shadowedSeqs: [2] }], ev), /Cycle/);
  assert.throws(() => expandWindowNodes([2], [{ seq: 2, shadowedSeqs: [1, 1] }, { seq: 1, shadowedSeqs: [0] }], ev), /Duplicate/);
  assert.throws(() => expandWindowNodes([2], [], ev), /no replacement/);
  assert.throws(() => expandWindowNodes([2], [{ seq: 2, shadowedSeqs: [1] }, { seq: 2, shadowedSeqs: [0] }], ev), /Duplicate replacement/);
});

test('invalid marker and malformed source log fail closed', () => {
  const s = Session.create('s'); const a = add(s, 'a');
  replace(s, a, a, '<dsh-openai-window>{bad');
  assert.throws(() => view(s), /Invalid window marker/);
  assert.throws(() => buildWindowRecoveryView({ events: [{ seq: 1, type: 'turn/start', data: { turn: 1 } }] }), /not contiguous/);
});

test('inclusive prefix excludes later parent data and inherited labels are bounded', () => {
  const s = Session.create('parent'); const a = add(s, 'a'); const b = add(s, 'b');
  const boundary = replace(s, a, b); add(s, 'secret-later');
  const v = view(s, { boundary });
  assert.deepEqual(v.entries.map((e) => e.seq), [a, b]);
  assert.ok(v.entries.every((e) => !e.inherited));
  assert.equal(v.boundary, boundary);
  assert.ok(!JSON.stringify(v).includes('secret-later'));
  assert.throws(() => view(s, { boundary: 999 }), /boundary/);
  assert.throws(() => view(s, { inheritedEventCount: 999 }), /inherited/);
});

test('actual fork seed does not duplicate synthetic results and preserves child tail', () => {
  const s = Session.create('parent');
  s.append('turn/start', { turn: 1 }); s.append('step/start', { turn: 1, step: 1 });
  const call = assistant(s, [['id1', 'read']]);
  const seed = buildForkSeed(s.snapshotEvents(), call);
  const inheritedEventCount = call + 1;
  const child = Session.create('child', seed, { ...s.header, id: 'child', isSeeded: true }, inheritedEventCount);
  add(child, 'child input');
  const v = view(child, { inheritedEventCount });
  assert.equal(v.diagnostics.filter((d) => d.code === 'missing-tool-result').length, 0);
  assert.equal(v.diagnostics.filter((d) => d.code === 'unmatched-tool-result').length, 0);
  assert.equal(v.entries.filter((e) => e.message.role === 'tool').length, 1);
  assert.equal(v.entries.at(-1).inherited, false);
  assert.equal(view(child).inheritedEventCount, inheritedEventCount);
  assert.throws(() => view(child, { inheritedEventCount: inheritedEventCount - 1 }), /fork marker/);
  const childBoundary = child.seq - 1;
  const grandchildSeed = buildForkSeed(child.snapshotEvents(), childBoundary);
  const grandchild = Session.create('grandchild', grandchildSeed, { ...child.header, id: 'grandchild' }, childBoundary + 1);
  const nested = view(grandchild);
  assert.equal(nested.inheritedEventCount, childBoundary + 1);
  assert.equal(nested.entries.filter((e) => e.message.role === 'tool').length, 1);
});

test('reports opaque private calls without leaking ciphertext in diagnostics', () => {
  const s = Session.create('s');
  const a = assistant(s, [['p', 'notes_write_file']]);
  result(s, 'p', JSON.stringify({ dshOpenaiWindowOutput: 1, encrypted_output: 'secret-ciphertext' }));
  const w = replace(s, a, s.surface.nodes.at(-1)); add(s, 'more');
  assert.ok(w);
  const v = view(s);
  const codes = v.diagnostics.map((d) => d.code);
  assert.ok(codes.includes('private-remote-tool'));
  assert.ok(codes.includes('private-remote-tool-result'));
  assert.ok(codes.includes('opaque-encrypted-content'));
  assert.ok(!JSON.stringify(v.diagnostics).includes('secret-ciphertext'));
});

test('detects unmatched, duplicate and missing tool pair IDs', () => {
  const s = Session.create('s');
  assistant(s, [['x', 'read'], ['x', 'read'], ['missing', 'read']]);
  result(s, 'unknown'); result(s, 'x'); result(s, 'x');
  const codes = view(s).diagnostics.map((d) => d.code);
  assert.ok(codes.includes('duplicate-open-tool-call-id'));
  assert.equal(codes.filter((x) => x === 'unmatched-tool-result').length, 2);
  assert.ok(codes.includes('missing-tool-result'));
});
