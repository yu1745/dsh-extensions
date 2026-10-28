import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { build } from 'esbuild';
import { Session, buildForkSeed } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

async function loadSource(path) {
  const source = resolve(path), directory = resolve('src');
  const filename = resolve(directory, `.fallback-test-${process.pid}-${randomUUID()}.mjs`);
  const code = (await build({ entryPoints: [source], bundle: true, packages: 'external', platform: 'node', format: 'esm', write: false })).outputFiles[0].text;
  await writeFile(filename, code, { flag: 'wx' });
  try { return await import(pathToFileURL(filename).href); }
  finally {
    if (dirname(filename) !== directory || !/^\.fallback-test-\d+-[a-f0-9-]+\.mjs$/.test(basename(filename))) throw new Error('Unexpected test module path');
    await unlink(filename);
  }
}
const { default: Owner, snapshotWithWindows } = await loadSource('src/openai-windows.ts');
const { default: Engine } = await loadSource('src/openai-window-compaction.ts');
const { initialWindow, foldWindow, windowProjection } = await loadSource('src/openai-window-state.ts');
let id = 0;
const sig = () => new AbortController().signal;
function harness(options = {}) {
  const session = options.session ?? Session.create(`owner-manual-${++id}`);
  let state = initialWindow(session.header), scanned = 0;
  const definitions = new Map(), sections = [], contexts = [], listeners = {}, scopeListeners = {};
  const snapshot = {}, adapter = { current: () => snapshot };
  const ctx = {
    reflect: { provide() {} }, fiber: { state: 2, uid: 'test-owner' }, agents: {},
    llm: { adapters: new Map([['openai-codex', { adapter }]]), resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 1000 }) },
    sessionProjections: { register() {}, stateOf(s) { for (const e of s.snapshotEvents(scanned)) state = foldWindow(state, e); scanned = s.seq; return state; } },
    sessions: { async flush() { return true; } },
    tokenMeter: { measure(s) { return { totalTokens: 4000, nodes: s.surface.nodes.map(seq => ({ seq, heuristicTokens: 4000 })) }; }, estimateMessage: () => 20 },
    on(name, fn) { const list = (listeners[name] ??= []); list.push(fn); return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }; }, get() { return undefined; },
  };
  const scope = {
    get: () => undefined,
    on(name, fn) { scopeListeners[name] = fn; return () => { if (scopeListeners[name] === fn) delete scopeListeners[name]; }; },
    effect(fn) { return fn(); },
    systemPrompt: { section(x) { sections.push(x); return () => {}; }, context(x) { contexts.push(x); return () => {}; } },
    tools: { presentAs() { return () => {}; }, register(x) { definitions.set(x.name, x); return () => definitions.delete(x.name); } },
  };
  const agent = { id: session.id, session, ctx: scope, status: 'idle', options: { provider: 'openai-codex', model: 'gpt-test' },
    inject(msg) { session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [msg] }); },
    runMaintenance(fn) { return fn(sig()); } };
  const config = { enabled: options.enabled ?? true, mode: options.mode ?? 'windows', thresholdRatio: 0.8, headroomTokens: 32768, reminderTokens: 16384 };
  const owner = new Owner(ctx, config); ctx.yuOpenaiWindows = owner;
  const engine = new Engine(ctx, { auto: false }); owner.attach(agent, engine);
  function step(signal = sig(), decision = { kind: 'enter', messages: [], startsRequestSeries: true }) {
    return scopeListeners['agent/pre-step']({ agent, signal }, async () => decision);
  }
  function transport(apiKey = 'test-fake-key', baseUrl = 'https://example.invalid/v1') {
    const route = { sessionId: agent.id, ...agent.options };
    const snapshot = { models: { streamSimple: (_m, _c, opts) => opts } };
    return snapshotWithWindows(snapshot, route).models.streamSimple({ api: 'openai-codex-responses', baseUrl, headers: {} }, {}, { apiKey });
  }
  function emit(name, ...args) { for (const fn of [...(listeners[name] ?? [])]) fn(...args); }
  function status(value) { agent.status = value; emit('agent/status', { agent, status: value }); }
  return { ctx, owner, engine, agent, session, definitions, sections, contexts, listeners, scopeListeners, step, transport, config, emit, status,
    state: () => ctx.sessionProjections.stateOf(session) };
}
function addAlphaMarker(h, backend = 'a'.repeat(64)) {
  const state = h.state();
  return h.session.append('user/message', createUserMessage({ source: { kind: 'compact-checkpoint', compactionId: 'alpha' }, content: [{ type: 'text', text: '<dsh-openai-window>' + JSON.stringify({ version: 1, ownerId: h.agent.id, sessionId: state.sessionId, windowId: 'old-window', index: 1, backend }) }] }), { surfaceOp: 'append' });
}
function addRemoteMarker(h) {
  return h.session.append('user/message', createUserMessage({ source: { kind: 'compact-checkpoint', compactionId: 'remote' }, content: [{ type: 'text', text: '<dsh-remote-compaction-v1>{}' }] }), { surfaceOp: 'append' });
}

test('windows is default, tools present without preflight or network', async () => {
  const h = harness(); const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected network'); };
  try {
    assert.deepEqual(h.owner.modeStatus(h.agent), { configured: 'windows', effective: 'windows', pinned: false, reason: null, applies: true });
    assert.equal(h.definitions.size, 11); assert.match(h.sections[0].text(), /checkpoint/);
    const decision = { kind: 'enter', messages: [], startsRequestSeries: true };
    assert.equal(await h.step(sig(), decision), decision); h.transport();
    assert.equal(await h.owner.verifyHandoff(h.agent, sig()), true);
    assert.equal(calls, 0); assert.equal(h.session.snapshotEvents().filter(e => e.type === 'agent/inbox/spliced').length, 0);
  } finally { globalThis.fetch = previous; }
});

test('volatile selection stays stable while running and applies on idle', async () => {
  const parsed = Owner.Config({ mode: 'remote' });
  assert.equal(typeof parsed.mode.get, 'function'); assert.equal(parsed.mode.get(), 'remote');
  let selected = 'windows'; const h = harness({ mode: { get: () => selected } });
  h.status('running'); selected = 'remote'; h.emit('settings/document-updated', 'yu-openai-windows');
  assert.deepEqual(h.owner.modeStatus(h.agent), { configured: 'remote', effective: 'windows', pinned: false, reason: null, applies: true });
  assert.equal(h.definitions.size, 11);
  await h.step(sig(), { kind: 'reject' }); assert.equal(h.owner.remoteMode(h.agent), false);
  const cancelled = new AbortController(); cancelled.abort('cancel');
  await assert.rejects(h.step(cancelled.signal), e => e === 'cancel');
  const during = await h.step(sig(), { kind: 'enter', messages: [] });
  assert.equal(during.startsRequestSeries, undefined); assert.equal(h.owner.remoteMode(h.agent), false);
  h.status('idle'); assert.equal(h.owner.remoteMode(h.agent), true); assert.equal(h.definitions.size, 0);
  h.status('running');
  await h.step(sig(), { kind: 'reject' });
  const after = await h.step(sig(), { kind: 'enter', messages: [], custom: 'preserved' });
  assert.equal(after.startsRequestSeries, true); assert.equal(after.custom, 'preserved');
  const event = h.session.append('step/start', { turn: 1, step: 1 }); h.emit('session/event', h.session, event);
  assert.equal((await h.step(sig(), { kind: 'enter', messages: [] })).startsRequestSeries, undefined);
  h.status('idle'); selected = 'windows'; h.emit('settings/document-updated', 'yu-openai-windows');
  assert.equal(h.owner.remoteMode(h.agent), false); assert.equal(h.definitions.size, 11);
});

test('owner replacement retains running mode until idle', async () => {
  const h = harness(); h.status('running');
  for (const fn of [...h.listeners.dispose]) fn();
  h.ctx.agents.list = () => [h.agent];
  const replacement = new Owner(h.ctx, { ...h.config, mode: 'remote' });
  h.ctx.yuOpenaiWindows = replacement;
  const engine = new Engine(h.ctx, { auto: false }); replacement.attach(h.agent, engine);
  assert.equal(replacement.modeStatus(h.agent).configured, 'remote');
  assert.equal(replacement.remoteMode(h.agent), false); assert.equal(h.definitions.size, 11);
  await h.step(); assert.equal(replacement.remoteMode(h.agent), false);
  h.status('idle'); assert.equal(replacement.remoteMode(h.agent), true); assert.equal(h.definitions.size, 0);
});

test('changing configuration does not interrupt an active tool call or probe alpha', async () => {
  const h = harness(); h.transport(); let release; const previous = globalThis.fetch;
  globalThis.fetch = () => new Promise(resolve => { release = resolve; });
  try {
    h.status('running');
    const tool = h.definitions.get('notes_list_files_by_prefix');
    const pending = tool.execute({}, { signal: sig() });
    h.config.mode = 'remote'; h.emit('settings/document-updated', 'yu-openai-windows');
    assert.equal(h.owner.remoteMode(h.agent), false);
    release(new Response(JSON.stringify({ encrypted_output: 'opaque' })));
    await pending; await h.step(); assert.equal(h.owner.remoteMode(h.agent), false);
    h.status('idle'); assert.equal(h.owner.remoteMode(h.agent), true); assert.equal(h.definitions.size, 0);
  } finally { globalThis.fetch = previous; }
});

test('assembly and tool snapshots follow idle switches in both directions', async () => {
  const h = harness();
  const reminder = h.session.append('user/message', createUserMessage({ source: { kind: 'system-prompt' }, content: [{ type: 'text', text: '<context_window_reminder>Save notes then call new_context.</context_window_reminder>' }] }), { surfaceOp: 'append' });
  const assemble = () => ({ prompt: h.sections.at(-1).text(), tools: [...h.definitions.keys()] });
  h.status('running'); const original = assemble();
  h.config.mode = 'remote'; h.emit('settings/document-updated', 'yu-openai-windows');
  assert.deepEqual(assemble(), original);
  assert.equal((await h.step(sig(), { kind: 'enter', messages: [] })).startsRequestSeries, undefined);
  h.status('idle'); const remote = assemble();
  assert.equal(remote.tools.length, 0); assert.match(remote.prompt, /Earlier window reminders/);
  assert.match(remote.prompt, /new_context no longer apply/);
  assert.ok(h.session.surface.nodes.includes(reminder.seq)); // history is retained, not silently deleted
  assert.match(h.session.eventAt(reminder.seq).data.content[0].text, /call new_context/);
  h.status('running');
  assert.equal((await h.step(sig(), { kind: 'reject' })).kind, 'reject');
  const cancelled = new AbortController(); cancelled.abort('cancel');
  await assert.rejects(h.step(cancelled.signal), e => e === 'cancel');
  assert.equal((await h.step(sig(), { kind: 'enter', messages: [] })).startsRequestSeries, true);
  const event = h.session.append('step/start', { turn: 1, step: 1 }); h.emit('session/event', h.session, event);
  h.config.mode = 'windows'; h.emit('settings/document-updated', 'yu-openai-windows');
  assert.deepEqual(assemble(), remote);
  h.status('idle'); const windows = assemble();
  assert.equal(windows.tools.length, 11); assert.match(windows.prompt, /notes_write_file/);
  h.status('running'); assert.equal((await h.step(sig(), { kind: 'enter', messages: [] })).startsRequestSeries, true);
});

test('settings do not change modes during idle-reported maintenance', async () => {
  const h = harness({ mode: 'remote' }); const entered = Promise.withResolvers(), release = Promise.withResolvers();
  h.owner.remoteCompaction = { compactNow: async () => { entered.resolve(); await release.promise; return null; } };
  const pending = h.engine.compactNow(h.agent, sig()); await entered.promise;
  h.config.mode = 'windows'; h.emit('settings/document-updated', 'yu-openai-windows');
  assert.equal(h.owner.remoteMode(h.agent), true);
  release.resolve(); await pending; assert.equal(h.owner.remoteMode(h.agent), false);
});

test('backend failures and invalid responses never change mode', async () => {
  for (const response of [new Response('', { status: 503 }), new Response('{}')]) {
    const h = harness(); h.transport(); const previous = globalThis.fetch;
    globalThis.fetch = async () => response;
    try {
      await assert.rejects(h.definitions.get('notes_list_files_by_prefix').execute({}, { signal: sig() }), /HTTP 503|invalid response/);
      assert.equal(h.owner.remoteMode(h.agent), false); assert.equal(h.definitions.size, 11);
      assert.equal(h.session.snapshotEvents().filter(e => e.type === 'agent/inbox/spliced').length, 0);
    } finally { globalThis.fetch = previous; }
  }
});

test('compaction lock defers switch; closed lock allows next boundary', async () => {
  const h = harness(); h.config.mode = 'remote';
  h.session.append('compaction/start', { compactionId: 'busy', turn: null });
  h.emit('settings/document-updated', 'yu-openai-windows');
  assert.equal(h.owner.remoteMode(h.agent), false);
  h.session.append('compaction/end', { compactionId: 'busy', turn: null });
  h.emit('settings/document-updated', 'yu-openai-windows');
  assert.equal(h.owner.remoteMode(h.agent), true);
});

test('existing alpha checkpoint pins windows through settings, reload and fork', async () => {
  const h = harness(); addAlphaMarker(h); h.config.mode = 'remote'; await h.step();
  assert.deepEqual(h.owner.modeStatus(h.agent), { configured: 'remote', effective: 'windows', pinned: true, reason: 'window-checkpoint', applies: true });
  h.owner.detach(h.agent, h.engine); h.owner.attach(h.agent, h.engine); await h.step();
  assert.equal(h.owner.remoteMode(h.agent), false); assert.equal(h.definitions.size, 11);
  const boundary = h.session.seq - 1, seed = buildForkSeed(h.session.snapshotEvents(), boundary);
  const child = Session.create('child-alpha', seed, { ...h.session.header, id: 'child-alpha', isSeeded: true }, boundary + 1);
  const restarted = harness({ session: child, mode: 'remote' });
  assert.equal(restarted.owner.modeStatus(restarted.agent).reason, 'window-checkpoint');
  assert.equal(restarted.owner.remoteMode(restarted.agent), false);
  assert.throws(() => restarted.transport('wrong-key'), /different endpoint\/account/);
});

test('remote checkpoint overrides earlier alpha history and pins remote through fork and restart', async () => {
  const h = harness({ mode: 'windows' }); addAlphaMarker(h); addRemoteMarker(h);
  assert.deepEqual(h.owner.modeStatus(h.agent), { configured: 'windows', effective: 'remote', pinned: true, reason: 'remote-checkpoint', applies: true });
  const boundary = h.session.seq - 1, seed = buildForkSeed(h.session.snapshotEvents(), boundary);
  const child = Session.create('child-remote', seed, { ...h.session.header, id: 'child-remote', isSeeded: true }, boundary + 1);
  const restored = harness({ session: child, mode: 'windows' });
  assert.equal(restored.owner.modeStatus(restored.agent).reason, 'remote-checkpoint');
  assert.equal(restored.owner.remoteMode(restored.agent), true);
});

test('disabled alpha checkpoint fails closed; disabled remote keeps replay boundary', async () => {
  const alpha = harness({ enabled: false }); addAlphaMarker(alpha);
  assert.throws(() => alpha.owner.assertRequestSafe(alpha.agent), /Previous encrypted window/);
  await assert.rejects(alpha.engine.compactIfNeeded(alpha.agent, 'pressure', sig()), /windows are disabled/);
  await assert.rejects(alpha.engine.compactNow(alpha.agent, sig()), /windows are disabled/);
  await assert.rejects(alpha.engine.compactRegion(0, 0, alpha.agent, sig()), /windows are disabled/);
  const remote = harness({ enabled: false }); addRemoteMarker(remote);
  assert.equal(remote.owner.remoteMode(remote.agent), true);
  assert.equal(remote.owner.modeStatus(remote.agent).reason, 'remote-checkpoint');
  const stream = remote.transport();
  assert.equal(typeof stream.onPayload, 'function');
  await assert.rejects(stream.onPayload({ input: [{ role: 'user', content: [{ type: 'input_text', text: '<dsh-remote-compaction-v1>{}' }] }] }));
  remote.agent.options = { provider: 'deepseek', model: 'deepseek-test' };
  await assert.rejects(remote.engine.compactNow(remote.agent, sig()), /Remote checkpoint/);
});

test('experimental auto fallback inbox marker is ignored', () => {
  const state = initialWindow({ id: 'owner' });
  const event = { type: 'agent/inbox/spliced', seq: 0, data: { target: 'next-step', inserted: [{ role: 'user', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: '<dsh-openai-remote-mode-v1>{"version":1,"ownerId":"owner","backend":"' + 'a'.repeat(64) + '"}' }] }] } };
  assert.equal(foldWindow(state, event), state); assert.equal(windowProjection.stateVersion, 3);
});

test('non-OpenAI requests and compaction are not polluted by global mode', async () => {
  const h = harness({ mode: 'remote' }); h.agent.options = { provider: 'deepseek', model: 'deepseek-test' }; h.owner.sync(h.agent);
  assert.equal(h.definitions.size, 0); assert.equal(h.owner.modeStatus(h.agent).applies, false);
  assert.doesNotThrow(() => h.owner.assertRequestSafe(h.agent));
});

test('remote lease cancels on settings, credentials, adapter and own model changes', () => {
  for (const event of ['llm/adapters-updated', 'credentials/record-updated', 'credentials/reference-updated', 'settings/document-updated', 'session/event']) {
    const h = harness({ mode: 'remote' }); h.transport();
    const identity = h.owner.remoteIdentity(h.agent), lease = h.owner.openRemoteLease({ agent: h.agent, identity, signal: sig() });
    assert.doesNotThrow(() => lease.check());
    if (event === 'session/event') {
      for (const fn of [...h.listeners[event]]) fn({ id: 'other' }, { type: 'model/selection' });
      assert.equal(lease.signal.aborted, false);
      for (const fn of [...h.listeners[event]]) fn(h.session, { type: 'model/selection' });
    } else if (event === 'settings/document-updated') {
      for (const fn of [...h.listeners[event]]) fn('unrelated-setting');
      assert.equal(lease.signal.aborted, false);
      for (const fn of [...h.listeners[event]]) fn('yu-openai-windows');
    } else for (const fn of [...h.listeners[event]]) fn('anything');
    assert.equal(lease.signal.aborted, true, event); assert.throws(() => lease.check(), /invalidated/);
    lease.dispose();
  }
});

test('remote lease validates captured snapshot, controller and volatile config', () => {
  const h = harness({ mode: 'remote' }); h.transport();
  const identity = h.owner.remoteIdentity(h.agent), lease = h.owner.openRemoteLease({ agent: h.agent, identity, signal: sig() });
  const captured = { api: 'openai-codex-responses', url: 'https://example.invalid/v1/responses', headers: { authorization: 'Bearer test-fake-key' },
    model: { provider: 'openai-codex', id: 'gpt-test', api: 'openai-codex-responses', baseUrl: 'https://example.invalid/v1' }, checkSnapshot() {} };
  assert.doesNotThrow(() => lease.check(captured));
  assert.throws(() => lease.check({ ...captured, checkSnapshot() { throw new Error('secret'); } }), /invalidated/);
  assert.throws(() => lease.check({ ...captured, checkSnapshot: undefined }), /invalidated/);
  h.config.mode = 'windows'; assert.throws(() => lease.check(), /invalidated/); lease.dispose();
  const changed = harness({ mode: 'remote' }); changed.transport();
  const old = changed.owner.openRemoteLease({ agent: changed.agent, identity: changed.owner.remoteIdentity(changed.agent), signal: sig() });
  changed.ctx.llm.adapters.get('openai-codex').adapter.current = () => ({});
  assert.throws(() => old.check(), /invalidated/); old.dispose();
});

test('preset engine disposal keeps checkpoint guard and rebinds the replacement', async () => {
  const h = harness(); addRemoteMarker(h); let current = h.engine;
  h.ctx.get = name => name === 'agentPresets' ? { serviceFor: () => current } : undefined;
  h.engine.trackAgent(h.agent);
  const disposeEngine = h.listeners.dispose.at(-1); disposeEngine();
  assert.throws(() => h.owner.assertRequestSafe(h.agent), /engine is unavailable/);
  const snapshot = { models: { streamSimple() {} } };
  assert.throws(() => snapshotWithWindows(snapshot, { ...h.agent.options, sessionId: h.agent.id }), /engine is unavailable/);
  current = new Engine(h.ctx, { auto: false });
  const wrapped = snapshotWithWindows(snapshot, { ...h.agent.options, sessionId: h.agent.id });
  assert.notEqual(wrapped, snapshot); assert.equal(h.owner.engineFor(h.agent), current);
  assert.equal(h.session.deriveMessages()[0].content[0].text, '<dsh-remote-compaction-v1>{}');
});

test('basic replacement cannot take ownership of encrypted checkpoints', async () => {
  const h = harness(); addAlphaMarker(h);
  const basic = { ctx: { fiber: { state: 2, uid: 'basic' } } };
  h.ctx.get = name => name === 'agentPresets' ? { serviceFor: () => basic } : undefined;
  h.engine.trackAgent(h.agent); h.listeners.dispose.at(-1)();
  assert.equal(h.owner.engineFor(h.agent), undefined);
  assert.throws(() => h.owner.assertRequestSafe(h.agent), /engine is unavailable/);
  const guard = h.listeners['llm/stream'][0], next = async function* () {};
  await assert.rejects(guard({ sessionId: h.agent.id, purpose: 'compaction' }, next).next(), /encrypted checkpoint/);
});

test('owner reload guards existing checkpoint before any replacement engine exists', () => {
  const h = harness(); addRemoteMarker(h);
  for (const fn of [...h.listeners.dispose]) fn();
  h.ctx.agents.list = () => [h.agent]; h.ctx.get = () => undefined;
  const replacement = new Owner(h.ctx, { ...h.config, mode: 'remote' });
  h.ctx.yuOpenaiWindows = replacement;
  const snapshot = { models: { streamSimple() {} } };
  assert.throws(() => snapshotWithWindows(snapshot, { ...h.agent.options, sessionId: h.agent.id }), /engine is unavailable/);
  assert.throws(() => replacement.assertRequestSafe(h.agent), /engine is unavailable/);
});

test('replacing remote controller during preparation prevents its commit', async () => {
  const h = harness({ mode: 'remote' }); h.transport();
  h.session.append('turn/start', { turn: 1 });
  const old = h.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'original '.repeat(300) }] }), { surfaceOp: 'append' }).seq;
  const controller = h.owner.remoteCompaction, entered = Promise.withResolvers(), release = Promise.withResolvers();
  controller.prepare = async () => { entered.resolve(); await release.promise; return [{ type: 'compaction', encrypted_content: 'opaque' }]; };
  assert.equal(controller.isActive(h.agent, h.engine), true);
  const attempt = h.engine.compactIfNeeded(h.agent, 'context-overflow', sig());
  await entered.promise; h.owner.remoteCompaction = {}; assert.equal(controller.isActive(h.agent, h.engine), false);
  release.resolve(); await assert.rejects(attempt);
  assert.deepEqual(h.session.surface.nodes, [old]);
  assert.equal(h.session.snapshotEvents().some(e => e.type === 'compaction/summary'), false);
});

test('remote mode commits and replays a mocked v2 checkpoint without notes tools', async () => {
  const h = harness({ mode: 'remote' }); h.transport(); await h.step();
  h.session.append('turn/start', { turn: 1 });
  const old = h.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'original-' + 'x'.repeat(1000) }] }), { surfaceOp: 'append' }).seq;
  h.owner.captureRemoteInput = async ({ options }) => ({
    api: 'openai-codex-responses', url: 'https://example.invalid/v1/responses', headers: { authorization: 'Bearer test-fake-key' },
    checkSnapshot() {},
    model: { provider: 'openai-codex', id: 'gpt-test', api: 'openai-codex-responses', baseUrl: 'https://example.invalid/v1' },
    payload: { model: 'gpt-test', instructions: 'system', input: options.messages.map(m => ({ role: m.role, content: m.content.map(b => ({ type: 'input_text', text: b.text })) })) },
  });
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(init.body).input.at(-1).type, 'compaction_trigger');
    return new Response(`data: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'compaction', encrypted_content: 'cipher' } })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', status: 'completed' } })}\n\n`);
  };
  try {
    const result = await h.engine.compactIfNeeded(h.agent, 'context-overflow', sig());
    assert.equal(result.durable, true); assert.equal(result.shadowedSeqs[0], old);
    const marker = h.session.eventAt(h.session.surface.nodes[0]).data.content[0].text;
    const stream = h.transport();
    const body = await stream.onPayload({ input: [{ role: 'user', content: [{ type: 'input_text', text: marker }] }, { role: 'user', content: [{ type: 'input_text', text: 'tail' }] }] });
    assert.equal(body.input.at(-2).encrypted_content, 'cipher'); assert.equal(body.input.at(-1).content[0].text, 'tail');
    assert.ok(!JSON.stringify(body).includes('<dsh-remote-compaction-v1>'));
    const guard = h.listeners['llm/stream'][0], next = async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; };
    await assert.rejects(guard({ sessionId: h.agent.id, purpose: 'compaction' }, next).next(), /text summarizer/);
    await assert.rejects(guard({ sessionId: h.agent.id, provider: 'deepseek', model: 'deepseek-test' }, next).next(), /cannot be replayed/);
    assert.equal(h.definitions.size, 0);
  } finally { globalThis.fetch = previous; }
});
