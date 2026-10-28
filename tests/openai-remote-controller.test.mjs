import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { RemoteCompactionController } from '../src/openai-remote-controller.mjs';
const identity = { provider: 'openai-codex', model: 'gpt-test', backendId: 'test-fingerprint' };
const output = [{ role: 'user', content: 'preserved' }, { type: 'compaction', encrypted_content: 'opaque' }];
const signal = new AbortController().signal;
function setup({ manual = false, used = 200, extra = 0, prepare = async () => output, flush = async () => true } = {}) {
  const session = Session.create('remote-controller');
  if (!manual) session.append('turn/start', { turn: 1 });
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'task' }] }), { surfaceOp: 'append' });
  const agent = { session, options: identity };
  const engine = { remoteServes: () => true, windowRange: () => ({ start: session.surface.nodes[0], end: session.surface.nodes.at(-1) }) };
  const ctx = { llm: { resolveModelInfo: async () => ({ context: { contextWindow: 1000 }, defaultMaxTokens: 0 }) }, tokenMeter: { measure: () => ({ totalTokens: used, nodes: session.surface.nodes.map(seq => ({ seq, heuristicTokens: 200 })) }) }, sessions: { flush } };
  const controller = new RemoteCompactionController({ ctx, route: () => identity, identity: () => identity, isActive: () => true, needsRecovery: () => false, prepare, verifyCanonicalOutput: (items, id) => JSON.stringify(items) === JSON.stringify(output) && id.backendId === identity.backendId, extraTokens: () => extra, config: { thresholdRatio: 0.8, headroomTokens: 100 } });
  return { controller, session, agent, engine, ctx };
}
test('pressure uses context budget and includes opaque checkpoint estimate', async () => {
  const h = setup({ used: 200 });
  assert.equal(await h.controller.compactIfNeeded(h.agent, 'pressure', signal, h.engine), null);
  assert.ok(!h.session.snapshotEvents().some(e => e.type === 'compaction/start'));
  const q = setup({ used: 200, extra: 700 });
  const result = await q.controller.compactIfNeeded(q.agent, 'pressure', signal, q.engine);
  assert.equal(result.durable, true); assert.equal(result.shadowedSeqs.length, 1);
});
test('remote failure or verification failure retains the current surface', async () => {
  for (const prepare of [async () => { throw Error('remote unavailable'); }, async () => [{ type: 'compaction', encrypted_content: 'bad' }]]) {
    const h = setup({ prepare }); const before = [...h.session.surface.nodes];
    await assert.rejects(h.controller.compactIfNeeded(h.agent, 'context-overflow', signal, h.engine));
    assert.deepEqual(h.session.surface.nodes, before);
  }
});
test('manual command preserves identity and a failed durable flush is explicit after replace', async () => {
  const h = setup({ manual: true, flush: async () => false });
  await assert.rejects(h.controller.compactNow(h.agent, signal, 'cmd-1', h.engine), (error) => error.code === 'flush-failed' && error.replaced);
  assert.equal(h.session.eventAt(h.session.surface.nodes[0]).data.source.sourceCommandId, 'cmd-1');
});
test('a post-replacement flush failure blocks requests until a real flush succeeds', async () => {
  let durable = false;
  const h = setup({ manual: true, flush: async () => durable });
  await assert.rejects(h.controller.compactNow(h.agent, signal, undefined, h.engine), (error) => error.code === 'flush-failed' && error.replaced);
  await assert.rejects(h.controller.ensureDurable(h.agent), /durability unavailable/);
  durable = true;
  await h.controller.ensureDurable(h.agent);
  durable = false; // A completed barrier is not repeated for the same incident.
  await h.controller.ensureDurable(h.agent);
});
test('a nonshrinking remote result keeps the original surface', async () => {
  const h = setup({ prepare: async () => [{ type: 'compaction', encrypted_content: 'x'.repeat(5000) }] });
  const before = [...h.session.surface.nodes];
  await assert.rejects(h.controller.compactIfNeeded(h.agent, 'context-overflow', signal, h.engine));
  assert.deepEqual(h.session.surface.nodes, before);
});
test('changed engine and cancellation prevent any replacement', async () => {
  let live = true;
  const h = setup({ prepare: async () => { live = false; return output; } }); h.engine.remoteServes = () => live;
  const before = [...h.session.surface.nodes];
  await assert.rejects(h.controller.compactIfNeeded(h.agent, 'context-overflow', signal, h.engine));
  assert.deepEqual(h.session.surface.nodes, before);
  const controller = new AbortController(); controller.abort();
  const q = setup(); await assert.rejects(q.controller.compactIfNeeded(q.agent, 'pressure', controller.signal));
  assert.ok(!q.session.snapshotEvents().some(e => e.type === 'compaction/start'));
});
