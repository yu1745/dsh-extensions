import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { basename, dirname, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { Context, Service, symbols } from '@deepseek-ai/cordis';
import { Session } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { sameService } from '../src/cordis-service-identity.mjs';

// Exercise real Cordis service reads, method-return tracing and shadow receivers.
// Ordinary ctx.get/serviceFor mocks cannot reproduce fresh service proxies.
const directory = resolve('src');
const filename = resolve(directory, `.cordis-identity-test-${process.pid}-${randomUUID()}.mjs`);
const code = buildSync({ stdin: { contents: `export { default as Engine } from './openai-window-compaction.ts';
export { default as Owner } from './openai-windows.ts';
export { initialWindow } from './openai-window-state.ts';`, resolveDir: resolve('src') }, bundle: true, packages: 'external', platform: 'node', format: 'esm', write: false }).outputFiles[0].text;
await writeFile(filename, code, { flag: 'wx' });
let loaded;
try { loaded = await import(pathToFileURL(filename).href); }
finally {
  assert.equal(dirname(filename), directory);
  assert.match(basename(filename), /^\.cordis-identity-test-\d+-[a-f0-9-]+\.mjs$/);
  await unlink(filename);
}
const { Engine, Owner, initialWindow } = loaded;
const signal = () => new AbortController().signal;
let serial = 0;

function harness(t, mode = 'remote') {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const session = Session.create(`cordis-identity-${++serial}`);
  const original = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'history '.repeat(3000) }] }), { surfaceOp: 'append' }).seq;
  const state = initialWindow(session.header);
  let selected, flushes = 0;
  // A real Service deliberately returns the raw implementation, just as the
  // actual AgentPresetRegistry's serviceForMount does. Cordis wraps the result.
  class Presets extends Service {
    constructor(ctx) { super(ctx, 'agentPresets'); }
    serviceFor() { return selected; }
  }
  new Presets(ctx);
  ctx.provide('agents', { list: () => [] });
  ctx.provide('sessionProjections', { register() {}, stateOf: () => state });
  ctx.provide('llm', { resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 1000 }) });
  ctx.provide('sessions', { async flush() { flushes++; return true; } });
  ctx.provide('tokenMeter', { measure(s) { return { totalTokens: 4000, nodes: s.surface.nodes.map(seq => ({ seq, heuristicTokens: 4000 })) }; }, estimateMessage: () => 20 });
  ctx.provide('systemPrompt', { section: () => () => {}, context: () => () => {} });
  ctx.provide('tools', { register: () => () => {}, presentAs: () => () => {} });
  const owner = new Owner(ctx, { enabled: true, mode, thresholdRatio: 0.8, headroomTokens: 32768, reminderTokens: 16384 });
  const engine = new Engine(ctx, { auto: false }); selected = engine;
  const agent = { id: session.id, ctx: ctx.extend(), session, status: 'idle', options: { provider: 'openai-codex', model: 'gpt-test' }, runMaintenance: fn => fn(signal()) };
  const backend = 'a'.repeat(64);
  owner.transports.set(agent, { identity: backend });
  owner.remoteCompaction.prepare = async () => [{ role: 'user', content: 'preserved' }, { type: 'compaction', encrypted_content: 'opaque' }];
  return { ctx, owner, engine, agent, session, state, original, backend, select: value => { selected = value; }, flushes: () => flushes };
}

test('real Cordis wrappers compare as one service, but not another implementation', t => {
  const h = harness(t);
  const first = h.ctx.get('compaction'), second = h.ctx.get('compaction');
  assert.notEqual(first, second);
  assert.notEqual(h.ctx.get('agentPresets').serviceFor(h.agent, 'compaction'), h.engine);
  assert.equal(first[symbols.original], h.engine);
  assert.equal(sameService(first, second), true);
  for (const engine of [h.engine, first, second]) {
    assert.equal(engine.serves(h.agent), true);
    assert.equal(engine.remoteServes(h.agent), true);
  }
  h.owner.attach(h.agent, first);
  const nested = h.ctx.get('yuOpenaiWindows').engineFor(h.agent);
  assert.notEqual(nested[symbols.original], h.engine);
  assert.equal(sameService(nested, h.engine), true);
  assert.equal(sameService(nested, second), true);
  h.select(harness(t).engine); // Same class/marker, genuinely different service.
  assert.equal(first.serves(h.agent), false);
  assert.equal(second.remoteServes(h.agent), false);
});

test('real traced manual compaction passes owner/controller checks and commits durably', async t => {
  const h = harness(t);
  const result = await h.ctx.get('compaction').compactNow(h.agent, signal(), 'command-identity');
  assert.ok(result);
  assert.equal(h.flushes(), 1);
  assert.notDeepEqual(h.session.surface.nodes, [h.original]);
  assert.equal(h.session.eventAt(result.summarySeq).data.sourceCommandId, 'command-identity');
});

test('real traced automatic and regional compaction retain elected engine ownership', async t => {
  for (const method of ['compactIfNeeded', 'compactRegion']) {
    const h = harness(t); h.session.append('turn/start', { turn: 1 });
    const engine = h.ctx.get('compaction');
    const result = method === 'compactIfNeeded'
      ? await engine.compactIfNeeded(h.agent, 'context-overflow', signal())
      : await engine.compactRegion(h.original, h.original, h.agent, signal());
    assert.ok(result, method);
    assert.equal(h.session.eventAt(result.endSeq).data.turn, 1);
  }
});

test('equivalent traced attachments do not churn generation and detach still works', t => {
  const h = harness(t), owner = h.ctx.get('yuOpenaiWindows');
  owner.attach(h.agent, h.ctx.get('compaction'));
  const capability = globalThis[Symbol.for('@yu1745/dsh-extensions/openai-window-capabilities')].get(h.agent);
  const generation = capability.generation;
  owner.attach(h.agent, h.ctx.get('compaction'));
  assert.equal(capability.generation, generation);
  assert.equal(h.owner.remoteCompaction.isActive(h.agent, h.ctx.get('compaction')), true);
  owner.detach(h.agent, h.ctx.get('compaction'));
  assert.equal(capability.generation, generation + 1);
});

test('real traced window handoff accepts unchanged owner and preset service wrappers', async t => {
  const h = harness(t, 'windows');
  h.state.backend = h.backend;
  h.state.checkpoint = { path: '/root/agent/notes/checkpoint', backend: h.backend, writeSeq: 1, readSeq: 2 };
  const result = await h.ctx.get('compaction').compactNow(h.agent, signal(), 'window-command');
  assert.ok(result);
  assert.equal(h.flushes(), 1);
  assert.equal(h.session.eventAt(result.summarySeq).data.summary[0].text.startsWith('<dsh-openai-window>'), true);
});

test('real engine replacement during remote prepare still rejects without replacing history', async t => {
  const h = harness(t);
  h.owner.remoteCompaction.prepare = async () => {
    h.select({});
    return [{ role: 'user', content: 'preserved' }, { type: 'compaction', encrypted_content: 'opaque' }];
  };
  await assert.rejects(h.ctx.get('compaction').compactNow(h.agent, signal()), e => e.code === 'transaction-failed' && e.replaced === false);
  assert.deepEqual(h.session.surface.nodes, [h.original]);
  assert.equal(h.session.snapshotEvents().some(e => e.type === 'compaction/summary'), false);
});
