import test from 'node:test';
import assert from 'node:assert/strict';
import { Module, createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { Session } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

const filename = resolve('src/.alpha-commit-test.cjs');
const code = buildSync({ entryPoints: [resolve('src/openai-window-compaction.ts')], bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const mod = new Module(filename); mod.filename = filename; mod.paths = Module._nodeModulePaths(dirname(filename)); mod.require = createRequire(filename); mod._compile(code, filename);
const Engine = mod.exports.default;
let serial = 0;
function harness(mode) {
  const projection = { type: 'image/offload', project(_event, { events }) {
    return new Map([[0, { ...events[0].data, content: [{ type: 'text', text: 'projected content' }] }]]);
  } };
  const session = Session.create(`alpha-commit-${++serial}`, undefined, undefined, undefined, [projection]);
  const original = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'old '.repeat(3000) }] }), { surfaceOp: 'append' }).seq;
  if (mode === 'automatic') session.append('turn/start', { turn: 1 });
  const identity = 'a'.repeat(64), path = '/root/agent/notes/checkpoint';
  const state = { index: 0, windowId: 'window-0', sessionId: 's', agentName: '/root/agent', backend: identity,
    checkpoint: { path, backend: identity, writeSeq: 1, readSeq: 2 }, pending: mode === 'automatic' ? { path, backend: identity } : null, lastInputSeq: 0, lastWorkSeq: 0 };
  let active = true, remote = false, flushes = 0;
  const listeners = {}, controller = new AbortController();
  const owner = { enabled: () => true, alphaActive: () => active, remoteMode: () => remote, state: () => state,
    transports: new WeakMap(), verifyHandoff: async () => true, attach() {}, sync() {}, remind() {} };
  const ctx = { reflect: { provide() {} }, yuOpenaiWindows: owner, get: () => undefined,
    on(name, fn) { (listeners[name] ??= []).push(fn); return () => {}; },
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 1000 }) },
    tokenMeter: { measure(s) { return { totalTokens: 4000, nodes: s.surface.nodes.map(seq => ({ seq, heuristicTokens: 4000 })) }; }, estimateMessage: () => 20 },
    sessions: { async flush() { flushes++; return true; } },
  };
  const agent = { id: session.id, session, ctx: { get: () => undefined }, options: { provider: 'openai-codex', model: 'gpt-test' },
    runMaintenance(fn) { return fn(new AbortController().signal); } };
  owner.transports.set(agent, { identity });
  const engine = new Engine(ctx, { auto: false });
  function execute() { return mode === 'manual' ? engine.compactNow(agent, controller.signal, 'cmd') : engine.compactIfNeeded(agent, 'pressure', controller.signal); }
  function afterVerified(mutate) {
    const originalSummarize = engine.summarize.bind(engine);
    engine.summarize = async (...args) => { const result = await originalSummarize(...args); mutate(); return result; };
  }
  return { session, original, state, owner, agent, engine, ctx, controller, listeners, execute, afterVerified,
    setActive(v) { active = v; }, setRemote(v) { remote = v; }, flushes: () => flushes };
}

test('successful automatic and manual commits use adjacent records and correct turn', async () => {
  for (const mode of ['automatic', 'manual']) {
    const h = harness(mode), result = await h.execute(), events = h.session.snapshotEvents();
    assert.ok(result); assert.equal(h.session.surface.nodes.length, 1);
    const summary = events[result.summarySeq], replacement = events[result.summarySeq + 1];
    assert.equal(summary.type, 'compaction/summary'); assert.equal(replacement.type, 'user/message');
    assert.deepEqual(replacement.sourceEventSeqs, [result.startSeq, result.summarySeq, ...result.shadowedSeqs]);
    assert.equal(events[result.startSeq].data.turn, mode === 'automatic' ? 1 : null);
    assert.equal(events[result.endSeq].data.turn, mode === 'automatic' ? 1 : null);
    assert.equal(h.flushes(), mode === 'manual' ? 1 : 0);
  }
});

test('verified handoff cannot commit after concurrent mode, route, identity, checkpoint, surface or engine changes', async () => {
  const mutations = {
    remote: h => h.setRemote(true),
    inactive: h => h.setActive(false),
    route: h => { h.agent.options.model = 'gpt-other'; },
    identity: h => { h.owner.transports.set(h.agent, { identity: 'b'.repeat(64) }); },
    checkpoint: h => { h.state.checkpoint = { ...h.state.checkpoint, path: '/changed' }; },
    pending: h => { h.state.pending = { path: '/changed' }; },
    userInputState: h => { h.state.lastInputSeq = 10; },
    surfaceAppend: h => h.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'new input' }] }), { surfaceOp: 'append' }),
    contentProjection: h => h.session.append('image/offload', {}),
    surfaceReplace: h => h.session.append('user/message', createUserMessage({ source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'other replacement' }] }), { surfaceOp: { op: 'replace', startSeq: h.original, endSeq: h.original }, sourceEventSeqs: [h.original] }),
    agentAbort: h => h.controller.abort('cancelled-after-verify'),
    ownerReplaced: h => { h.ctx.yuOpenaiWindows = {}; },
    fiberDisposed: h => { h.ctx.fiber = { state: 4, uid: null }; },
    engineDisposed: h => { for (const fn of h.listeners.dispose) fn(); },
  };
  for (const mode of ['automatic', 'manual']) for (const [label, mutate] of Object.entries(mutations)) {
    const h = harness(mode); h.afterVerified(() => mutate(h));
    await assert.rejects(h.execute(), undefined, `${mode}/${label}`);
    const events = h.session.snapshotEvents();
    assert.equal(events.filter(e => e.type === 'compaction/summary').length, 0, `${mode}/${label}`);
    assert.equal(events.filter(e => e.type === 'user/message' && e.data.source?.kind === 'compact-checkpoint').length, 0, `${mode}/${label}`);
    assert.equal(events.filter(e => e.type === 'compaction/start').length, 1, `${mode}/${label}`);
    assert.equal(events.filter(e => e.type === 'compaction/end').length, 1, `${mode}/${label}`);
    assert.equal(h.flushes(), mode === 'manual' ? 1 : 0, `${mode}/${label}`);
  }
});

test('preset registry disappearing after verification fails closed', async () => {
  for (const mode of ['automatic', 'manual']) {
    const h = harness(mode), registry = { serviceFor: () => h.engine };
    h.ctx.get = name => name === 'agentPresets' ? registry : undefined;
    h.afterVerified(() => { h.ctx.get = () => undefined; });
    await assert.rejects(h.execute(), /changed before commit/);
    assert.equal(h.session.snapshotEvents().some(e => e.type === 'compaction/summary'), false);
    assert.deepEqual(h.session.surface.nodes, [h.original]);
  }
});

test('changed turn leaves durable lock unmatched, never forges close outside turn', async () => {
  const h = harness('automatic');
  h.afterVerified(() => h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await assert.rejects(h.execute(), /changed before commit/);
  assert.equal(h.session.snapshotEvents().filter(e => e.type === 'compaction/summary').length, 0);
  assert.equal(h.session.snapshotEvents().filter(e => e.type === 'compaction/end').length, 0);
  assert.deepEqual(h.session.surface.nodes, [h.original]);
});
