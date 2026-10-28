import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { commitRemoteCheckpoint, replayRemoteCheckpoint } from '../src/openai-remote-checkpoint-prototype.mjs';
const identity = { provider: 'openai', model: 'gpt-x', backendId: 'account' };
const verify = () => true; // Test-only; not evidence of provider canonicality.
const add = (s) => s.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }), { surfaceOp: 'append' }).seq;
const opts = (s, seq) => ({ session: s, start: seq, end: seq, identity, prepare: async () => [{ type: 'compaction', encrypted_content: 'sealed' }], verifyCanonicalOutput: verify, flush: async () => {} });
const code = (c, replaced) => e => (assert.equal(e.code, c), assert.equal(e.replaced, replaced), true);

test('close failure after Session replacement is explicitly marked replaced', async () => {
  const s = Session.create('s'), a = add(s); let flushes = 0;
  const proxy = new Proxy(s, { get(target, key) {
    if (key === 'append') return (type, ...rest) => { if (type === 'compaction/end') throw Error('private'); return target.append(type, ...rest); };
    const v = Reflect.get(target, key, target); return typeof v === 'function' ? v.bind(target) : v;
  } });
  await assert.rejects(commitRemoteCheckpoint({ ...opts(proxy, a), flush: async () => { flushes++; } }), code('close-failed', true));
  assert.equal(flushes, 1);
  assert.equal(s.eventAt(s.surface.nodes[0]).data.source.kind, 'compact-checkpoint');
  assert.equal(s.snapshotEvents().at(-1).type, 'user/message');
});

test('non-lossless JSON output never enters a checkpoint', async () => {
  const s = Session.create('s'), a = add(s);
  await assert.rejects(commitRemoteCheckpoint({ ...opts(s, a), prepare: async () => [{ type: 'compaction', value: NaN }] }), code('invalid-record', false));
  assert.equal(s.surface.nodes[0], a);
});

test('tampered summary hash or missing source citations cannot replay', async () => {
  const s = Session.create('s'), a = add(s); await commitRemoteCheckpoint(opts(s, a));
  const marker = s.eventAt(s.surface.nodes[0]);
  const payload = { input: [{ role: 'user', content: [{ type: 'input_text', text: marker.data.content[0].text }] }] };
  const originalEvents = s.snapshotEvents();
  const tampered = { surface: s.surface, eventAt: s.eventAt.bind(s), snapshotEvents: () => originalEvents.map(e => e.seq === marker.seq - 1 ? { ...e, data: { ...e.data, summary: [{ type: 'text', text: e.data.summary[0].text + 'x' }] } } : e) };
  assert.throws(() => replayRemoteCheckpoint({ session: tampered, payload, identity, verifyCanonicalOutput: verify }), code('record-mismatch', false));
  const forgedMarker = { ...marker, sourceEventSeqs: marker.sourceEventSeqs.slice(0, -1) };
  const badSources = { surface: s.surface, eventAt: seq => seq === marker.seq ? forgedMarker : s.eventAt(seq), snapshotEvents: () => originalEvents };
  assert.throws(() => replayRemoteCheckpoint({ session: badSources, payload, identity, verifyCanonicalOutput: verify }), code('invalid-transaction', false));
});

test('all four command references must agree and invalid inputs fail before start', async () => {
  const s = Session.create('commands'), a = add(s);
  for (const invalid of ['', '  ', null, 12]) {
    await assert.rejects(commitRemoteCheckpoint({ ...opts(s, a), sourceCommandId: invalid }), code('invalid-source-command-id', false));
    assert.equal(s.surface.nodes[0], a);
  }
  assert.ok(!s.snapshotEvents().some(e => e.type === 'compaction/start'));
  await commitRemoteCheckpoint({ ...opts(s, a), sourceCommandId: 'cmd-1' });
  const marker = s.eventAt(s.surface.nodes[0]), events = s.snapshotEvents();
  const payload = { input: [{ role: 'user', content: [{ type: 'input_text', text: marker.data.content[0].text }] }] };
  for (const kind of ['compaction/start', 'compaction/summary', 'compaction/end', 'user/message']) {
    const map = e => {
      if (kind === 'user/message' && e.seq === marker.seq) return { ...e, data: { ...e.data, source: { ...e.data.source, sourceCommandId: 'cmd-2' } } };
      if (kind !== 'user/message' && e.type === kind) return { ...e, data: { ...e.data, sourceCommandId: 'cmd-2' } };
      return e;
    };
    const fake = { surface: s.surface, eventAt: seq => map(s.eventAt(seq)), snapshotEvents: () => events.map(map) };
    assert.throws(() => replayRemoteCheckpoint({ session: fake, payload, identity, verifyCanonicalOutput: verify }), code('invalid-transaction', false));
  }
});

test('command ID remains on failure lifecycle and is omitted when absent', async () => {
  const s = Session.create('failure'), a = add(s);
  await assert.rejects(commitRemoteCheckpoint({ ...opts(s, a), sourceCommandId: 'cmd-1', prepare: async () => { throw Error('secret'); } }), code('transaction-failed', false));
  const lifecycle = s.snapshotEvents().filter(e => e.type === 'compaction/start' || e.type === 'compaction/end');
  assert.deepEqual(lifecycle.map(e => e.data.sourceCommandId), ['cmd-1', 'cmd-1']);
  const noId = Session.create('no-id'), b = add(noId);
  const result = await commitRemoteCheckpoint(opts(noId, b));
  assert.ok(!Object.hasOwn(result, 'sourceCommandId'));
  const marker = noId.eventAt(noId.surface.nodes[0]);
  for (const event of noId.snapshotEvents().filter(e => e.type === 'compaction/start' || e.type === 'compaction/end' || e.type === 'compaction/summary')) assert.ok(!Object.hasOwn(event.data, 'sourceCommandId'));
  assert.ok(!Object.hasOwn(marker.data.source, 'sourceCommandId'));
});

test('real Session content projections during prepare or verify fail closed without changing surface nodes', async () => {
  const projection = {
    type: 'plugin:test/rewrite',
    project(event, context) {
      const old = context.messages.get(event.data.target) ?? context.events[event.data.target].data;
      return new Map([[event.data.target, { ...old, content: [{ type: 'text', text: 'rewritten' }] }]]);
    },
  };
  for (const stage of ['prepare', 'verify']) {
    const s = Session.create(`projection-${stage}`, undefined, undefined, undefined, [projection]);
    const a = add(s), before = [...s.surface.nodes], generation = s.surface.contentGeneration;
    const mutate = () => s.append('plugin:test/rewrite', { target: a });
    const base = opts(s, a);
    await assert.rejects(commitRemoteCheckpoint({ ...base,
      prepare: async () => { if (stage === 'prepare') mutate(); return [{ type: 'compaction', encrypted_content: 'sealed' }]; },
      verifyCanonicalOutput: () => { if (stage === 'verify') mutate(); return true; },
    }), code('surface-changed', false));
    assert.deepEqual([...s.surface.nodes], before);
    assert.equal(s.surface.contentGeneration, generation + 1);
    assert.equal(s.deriveMessages()[0].content[0].text, 'rewritten');
    assert.ok(!s.snapshotEvents().some(e => e.type === 'compaction/summary'));
    assert.equal(s.snapshotEvents().at(-1).type, 'compaction/end');
  }
});

test('replacement generation changes without node changes also fail closed', async () => {
  for (const stage of ['prepare', 'verify']) {
    const s = Session.create(`replace-${stage}`), a = add(s); let bump = 0;
    const proxy = new Proxy(s, { get(target, key) {
      if (key === 'surface') return { nodes: target.surface.nodes, contentGeneration: target.surface.contentGeneration, replaceGeneration: target.surface.replaceGeneration + bump };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await assert.rejects(commitRemoteCheckpoint({ ...opts(proxy, a),
      prepare: async () => { if (stage === 'prepare') bump++; return [{ type: 'compaction', encrypted_content: 'sealed' }]; },
      verifyCanonicalOutput: () => { if (stage === 'verify') bump++; return true; },
    }), code('surface-changed', false));
    assert.deepEqual([...s.surface.nodes], [a]);
    assert.ok(!s.snapshotEvents().some(e => e.type === 'compaction/summary'));
  }
});

test('manual idle and automatic open turn use correctly matched owners', async () => {
  const manual = Session.create('manual');
  manual.append('turn/start', { turn: 1 }); const a = add(manual);
  manual.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await commitRemoteCheckpoint(opts(manual, a));
  const me = manual.snapshotEvents().filter(e => e.type === 'compaction/start' || e.type === 'compaction/end');
  assert.deepEqual(me.map(e => e.data.turn), [null, null]);
  const auto = Session.create('auto'); auto.append('turn/start', { turn: 42 }); const b = add(auto);
  await commitRemoteCheckpoint({ ...opts(auto, b), mode: 'automatic' });
  const ae = auto.snapshotEvents().filter(e => e.type === 'compaction/start' || e.type === 'compaction/end');
  assert.deepEqual(ae.map(e => e.data.turn), [42, 42]);
  const marker = auto.eventAt(auto.surface.nodes[0]);
  const payload = { input: [{ role: 'user', content: [{ type: 'input_text', text: marker.data.content[0].text }] }] };
  assert.deepEqual(replayRemoteCheckpoint({ session: auto, payload, identity, verifyCanonicalOutput: verify }).input, [{ type: 'compaction', encrypted_content: 'sealed' }]);
  const events = auto.snapshotEvents();
  const altered = { surface: auto.surface, eventAt: auto.eventAt.bind(auto), snapshotEvents: () => events.map(e => e.type === 'compaction/end' ? { ...e, data: { ...e.data, turn: null } } : e) };
  assert.throws(() => replayRemoteCheckpoint({ session: altered, payload, identity, verifyCanonicalOutput: verify }), code('invalid-transaction', false));
});

test('manual busy, automatic idle, unmatched or nested turn history all fail before lock', async () => {
  const open = Session.create('open'); open.append('turn/start', { turn: 1 }); const a = add(open);
  await assert.rejects(commitRemoteCheckpoint(opts(open, a)), code('turn-busy', false));
  const idle = Session.create('idle'); const b = add(idle);
  await assert.rejects(commitRemoteCheckpoint({ ...opts(idle, b), mode: 'automatic' }), code('no-open-turn', false));
  const unmatched = Session.create('unmatched'); const c = add(unmatched); unmatched.append('turn/end', { turn: 7, reason: { kind: 'completed' } });
  await assert.rejects(commitRemoteCheckpoint(opts(unmatched, c)), code('invalid-turn-history', false));
  const nested = Session.create('nested'); const d = add(nested); nested.append('turn/start', { turn: 1 }); nested.append('turn/start', { turn: 2 });
  await assert.rejects(commitRemoteCheckpoint({ ...opts(nested, d), mode: 'automatic' }), code('invalid-turn-history', false));
  for (const s of [open, idle, unmatched, nested]) assert.ok(!s.snapshotEvents().some(e => e.type === 'compaction/start'));
});

test('turn ending during preparation does not replace or create an invalid owner close', async () => {
  const s = Session.create('race'); s.append('turn/start', { turn: 3 }); const a = add(s);
  let flushed = false;
  await assert.rejects(commitRemoteCheckpoint({ ...opts(s, a), mode: 'automatic', flush: async () => { flushed = true; },
    prepare: async () => { s.append('turn/end', { turn: 3, reason: { kind: 'completed' } }); return [{ type: 'compaction', encrypted_content: 'sealed' }]; },
  }), code('turn-or-lock-changed', false));
  assert.equal(s.surface.nodes[0], a);
  assert.ok(flushed);
  assert.ok(!s.snapshotEvents().some(e => e.type === 'compaction/end'));
  await assert.rejects(commitRemoteCheckpoint(opts(s, a)), code('busy', false));
});

test('automatic flush failure and cancellation after replace retain replaced flag and owner', async () => {
  for (const how of ['flush', 'cancel']) {
    const s = Session.create(`auto-${how}`); s.append('turn/start', { turn: 8 }); const a = add(s);
    const controller = new AbortController();
    await assert.rejects(commitRemoteCheckpoint({ ...opts(s, a), mode: 'automatic', signal: controller.signal,
      flush: async () => { if (how === 'flush') throw Error('failure'); controller.abort(); },
    }), code(how === 'flush' ? 'flush-failed' : 'cancelled', true));
    assert.equal(s.snapshotEvents().find(e => e.type === 'compaction/end').data.turn, 8);
    assert.equal(s.eventAt(s.surface.nodes[0]).data.source.kind, 'compact-checkpoint');
  }
});
