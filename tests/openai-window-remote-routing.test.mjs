import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import { dirname, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { Session } from '@deepseek-ai/dsh-session';
import { createUserMessage, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';

// Compile the source in memory. Do not rebuild lib or touch installed plugins.
const source = resolve('src/openai-window-compaction.ts');
const compiled = buildSync({ entryPoints: [source], bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const moduleForTest = new Module(resolve('src/.remote-routing-test.cjs'));
moduleForTest.filename = resolve('src/.remote-routing-test.cjs');
moduleForTest.paths = Module._nodeModulePaths(dirname(moduleForTest.filename));
moduleForTest.require = createRequire(moduleForTest.filename);
moduleForTest._compile(compiled, moduleForTest.filename);
const Engine = moduleForTest.exports.default;
const liveSignal = () => new AbortController().signal;

function harness(route = { provider: 'openai-codex', model: 'gpt-test' }) {
  const listeners = {}, calls = [];
  let index = 0, mode = true, selectedOwner;
  const session = Session.create('remote-routing-test');
  const a = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] }), { surfaceOp: 'append' }).seq;
  const b = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'last' }] }), { surfaceOp: 'append' }).seq;
  const owner = {
    enabled: (r) => r.provider === 'openai-codex',
    state: () => ({ index }), remoteMode: () => mode,
    attach() {}, sync() {},
    remoteCompaction: {
      compactIfNeeded(...args) { calls.push(['auto', ...args]); return Promise.resolve('auto'); },
      compactNow(...args) { calls.push(['manual', ...args]); return Promise.resolve('manual'); },
      compactRegion(...args) { calls.push(['region', ...args]); return Promise.resolve('region'); },
    },
  };
  const ctx = {
    reflect: { provide() {} }, yuOpenaiWindows: owner,
    on: (name, fn) => { (listeners[name] ??= []).push(fn); return () => {}; },
    get: (name) => name === 'agentPresets' && selectedOwner ? { serviceFor: () => selectedOwner } : undefined,
  };
  const agent = { id: session.id, session, options: route, ctx: { get: () => undefined }, runMaintenance: (fn) => fn(liveSignal()) };
  const engine = new Engine(ctx, { auto: false });
  return { engine, owner, agent, session, calls, a, b, listeners, setIndex: (n) => { index = n; }, setMode: (v) => { mode = v; }, setOwner: (v) => { selectedOwner = v; } };
}

 test('remote mode delegates exactly once with unchanged parameters and engine', async () => {
  const h = harness(), signal = liveSignal();
  assert.equal(await h.engine.compactIfNeeded(h.agent, 'context-overflow', signal), 'auto');
  assert.deepEqual(h.calls[0], ['auto', h.agent, 'context-overflow', signal, h.engine]);
  let maintenance = 0;
  h.agent.runMaintenance = (fn) => { maintenance++; return fn(liveSignal()); };
  assert.equal(await h.engine.compactNow(h.agent, signal, 'command-1'), 'manual');
  assert.equal(maintenance, 1); assert.equal(h.calls[1][0], 'manual');
  assert.equal(h.calls[1][1], h.agent); assert.equal(h.calls[1][3], 'command-1'); assert.equal(h.calls[1][4], h.engine);
  assert.ok(h.calls[1][2] instanceof AbortSignal);
  h.session.append('turn/start', { turn: 1 });
  assert.equal(await h.engine.compactRegion(h.a, h.b, h.agent, signal), 'region');
  assert.deepEqual(h.calls[2], ['region', h.agent, h.a, h.b, signal, h.engine]);
  assert.deepEqual(h.session.surface.nodes, [h.a, h.b]);
});

test('missing remote methods fail closed, never delegate to basic summary', async () => {
  const h = harness(); h.owner.remoteCompaction = {};
  await assert.rejects(h.engine.compactIfNeeded(h.agent, 'pressure', liveSignal()), /missing compactIfNeeded/);
  await assert.rejects(h.engine.compactNow(h.agent, liveSignal()), /missing compactNow/);
  await assert.rejects(h.engine.compactRegion(h.a, h.b, h.agent, liveSignal()), /missing compactRegion/);
  assert.deepEqual(h.session.surface.nodes, [h.a, h.b]);
});

test('other provider uses native basic; encrypted checkpoint blocks all three paths', async () => {
  const h = harness({ provider: 'deepseek', model: 'deepseek-test' });
  const names = ['compactIfNeeded', 'compactNow', 'compactRegion'];
  const original = names.map((name) => BasicCompactionEngine.prototype[name]);
  try {
    for (const name of names) BasicCompactionEngine.prototype[name] = async () => `basic-${name}`;
    assert.equal(await h.engine.compactIfNeeded(h.agent, 'pressure', liveSignal()), 'basic-compactIfNeeded');
    assert.equal(await h.engine.compactNow(h.agent, liveSignal()), 'basic-compactNow');
    assert.equal(await h.engine.compactRegion(h.a, h.b, h.agent, liveSignal()), 'basic-compactRegion');
    assert.equal(h.calls.length, 0);
    h.setIndex(1);
    await assert.rejects(h.engine.compactIfNeeded(h.agent, 'pressure', liveSignal()), /encrypted window checkpoints/);
    await assert.rejects(h.engine.compactNow(h.agent, liveSignal()), /encrypted window checkpoints/);
    await assert.rejects(h.engine.compactRegion(h.a, h.b, h.agent, liveSignal()), /encrypted window checkpoints/);
  } finally { names.forEach((name, i) => { BasicCompactionEngine.prototype[name] = original[i]; }); }
});

test('OpenAI with remote mode off retains existing window policy', async () => {
  const h = harness(); h.setMode(false);
  await assert.rejects(h.engine.compactNow(h.agent, liveSignal()), /checkpoint/);
  await assert.rejects(h.engine.compactRegion(h.a, h.a, h.agent, liveSignal()), /complete balanced/);
  assert.equal(h.calls.length, 0);
});

test('manual maintenance rejects busy, cancellation, active compaction and stale service', async () => {
  const h = harness();
  h.agent.runMaintenance = () => { throw new Error('already running'); };
  await assert.rejects(h.engine.compactNow(h.agent, liveSignal()), (e) => e.code === 'busy');
  const ctrl = new AbortController(); ctrl.abort('caller-cancel');
  await assert.rejects(h.engine.compactNow(h.agent, ctrl.signal), (e) => e === 'caller-cancel');
  h.agent.runMaintenance = (fn) => { const c = new AbortController(); c.abort('maintenance-cancel'); return fn(c.signal); };
  await assert.rejects(h.engine.compactNow(h.agent, liveSignal()), (e) => e.code === 'cancelled');
  h.agent.runMaintenance = (fn) => fn(liveSignal());
  h.session.append('compaction/start', { compactionId: 'busy', turn: null });
  await assert.rejects(h.engine.compactNow(h.agent, liveSignal()), (e) => e.code === 'busy');
  await assert.rejects(h.engine.compactIfNeeded(h.agent, 'pressure', liveSignal()), (e) => e.code === 'busy');
  await assert.rejects(h.engine.compactRegion(h.a, h.b, h.agent, liveSignal()), (e) => e.code === 'busy');
  assert.equal(h.calls.length, 0);
});

test('maintenance admission rechecks engine ownership and fallback service', async () => {
  for (const mutate of [
    (h) => h.setOwner({}),
    (h) => { h.owner.remoteCompaction = {}; },
    (h) => h.setMode(false),
    (h) => { h.agent.options = { provider: 'deepseek', model: 'deepseek-test' }; },
    (h) => { for (const fn of h.listeners.dispose) fn(); },
  ]) {
    const h = harness();
    h.agent.runMaintenance = (fn) => { mutate(h); return fn(liveSignal()); };
    await assert.rejects(h.engine.compactNow(h.agent, liveSignal()), /engine|route or service/i);
    assert.equal(h.calls.length, 0);
  }
});

test('inactive engine never invokes fallback, including after disposal', async () => {
  const h = harness(); h.setOwner({});
  assert.equal(await h.engine.compactIfNeeded(h.agent, 'pressure', liveSignal()), null);
  await assert.rejects(h.engine.compactNow(h.agent, liveSignal()), /no longer active/);
  await assert.rejects(h.engine.compactRegion(h.a, h.b, h.agent, liveSignal()), /no longer active/);
  for (const fn of h.listeners.dispose) fn();
  assert.equal(await h.engine.compactIfNeeded(h.agent, 'pressure', liveSignal()), null);
  await assert.rejects(h.engine.compactNow(h.agent, liveSignal()), /retired/);
  await assert.rejects(h.engine.compactRegion(h.a, h.b, h.agent, liveSignal()), /retired/);
  assert.equal(h.calls.length, 0);
});

test('cancellation and disposal during async fallback do not report success', async () => {
  for (const method of ['compactIfNeeded', 'compactNow', 'compactRegion']) {
    const h = harness(), controller = new AbortController();
    if (method === 'compactRegion') h.session.append('turn/start', { turn: 1 });
    h.owner.remoteCompaction[method] = async () => { controller.abort('cancel-during-remote'); return 'not-success'; };
    const action = method === 'compactIfNeeded' ? h.engine.compactIfNeeded(h.agent, 'pressure', controller.signal)
      : method === 'compactNow' ? h.engine.compactNow(h.agent, controller.signal)
      : h.engine.compactRegion(h.a, h.b, h.agent, controller.signal);
    await assert.rejects(action, (e) => e === 'cancel-during-remote');
  }
  const h = harness();
  h.owner.remoteCompaction.compactIfNeeded = async () => { for (const fn of h.listeners.dispose) fn(); return 'not-success'; };
  await assert.rejects(h.engine.compactIfNeeded(h.agent, 'pressure', liveSignal()), /no longer active/);
});

test('remote ownership fails closed when preset resolution is unavailable or fiber inactive', async () => {
  for (const configure of [
    (h) => { h.engine.ctx.get = () => ({ serviceFor: () => undefined }); },
    (h) => { h.engine.ctx.get = () => ({ serviceFor: () => { throw new Error('disposed'); } }); },
    (h) => { h.engine.ctx.fiber = { state: 1, uid: 'retired' }; },
  ]) {
    const h = harness(); configure(h);
    await assert.rejects(h.engine.compactIfNeeded(h.agent, 'pressure', liveSignal()), /no longer active/);
    await assert.rejects(h.engine.compactNow(h.agent, liveSignal()), /no longer active/);
    await assert.rejects(h.engine.compactRegion(h.a, h.b, h.agent, liveSignal()), /no longer active/);
    assert.equal(h.calls.length, 0);
  }
});

test('manual requires closed turn and region requires current turn', async () => {
  const h = harness();
  await assert.rejects(h.engine.compactRegion(h.a, h.b, h.agent, liveSignal()), /no open turn/);
  h.session.append('turn/start', { turn: 1 });
  await assert.rejects(h.engine.compactNow(h.agent, liveSignal()), (e) => e.code === 'busy');
  assert.equal(h.calls.length, 0);
});

test('remote range validates membership and exact paired cuts', async () => {
  const h = harness();
  const s = h.session;
  s.append('turn/start', { turn: 1 });
  const call = s.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ source: h.agent.options, content: [{ type: 'tool-call', id: 'call', name: 'test', arguments: '{}' }] }) }, { surfaceOp: 'append' }).seq;
  const result = s.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'call', content: [{ type: 'text', text: 'ok' }], isError: false }) }, { surfaceOp: 'append' }).seq;
  await assert.rejects(h.engine.compactRegion(call, call, h.agent, liveSignal()), /balanced/);
  await assert.rejects(h.engine.compactRegion(999, result, h.agent, liveSignal()), /balanced/);
  await assert.rejects(h.engine.compactRegion(result, call, h.agent, liveSignal()), /balanced/);
  assert.equal(await h.engine.compactRegion(call, result, h.agent, liveSignal()), 'region');
});
