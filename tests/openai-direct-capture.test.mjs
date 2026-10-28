// Offline proof-of-concept tests with real Cordis/LlmRuntime/PiAiAdapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { probeSnapshot, installSnapshotObserver, createSnapshotRecord, initializeTransport } from '../src/openai-direct-capture.mjs';
import { registerAdapterWrapper } from '../src/openai-adapter-chain.mjs';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter, createSystemMessage, createUserMessage, createAssistantMessage, createToolResultMessage, createDeveloperMessage } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import Owner, { snapshotWithWindows } from '../lib/openai-windows.js';
import Engine from '../lib/openai-window-compaction.js';
import { initialWindow, foldWindow } from '../lib/openai-window-state.js';
import { Session } from '@deepseek-ai/dsh-session';
const jwt = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic' } })).toString('base64url')}.fake`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lmY4AAAAASUVORK5CYII=', 'base64');
const image = { attachmentId: 'synthetic-image', mediaType: 'image/png', bytes: png.length, width: 1, height: 1, name: 'one.png' };
const file = { attachmentId: 'a'.repeat(64), bytes: 5, name: 'sample.txt' };
const tool = { name: 'tool_a', description: 'a', parameters: { type: 'object', properties: {} } };
const tool2 = { name: 'tool_b', description: 'b', parameters: { type: 'object', properties: {} } };
const profile = (provider, modelId) => {
  const p = provider === 'openai' ? openaiProvider() : openaiCodexProvider();
  if (modelId !== 'gpt-6-astra') {
    const original = p.getModels;
    p.getModels = () => { const models = original(); return [...models, { ...models.find(m => m.id === 'gpt-6-astra'), id: modelId, name: 'Synthetic dynamic model' }]; };
  }
  return { piProvider: p, modelErrors: new Map(), configuredMaxTokens: new Map(), streamIdleTimeoutMs: 5000, requestImagePixelBudget: 4194304, requestImageMaxBytes: 1048576 };
};
function fixture(provider, model) {
  const dev = createDeveloperMessage({ source: { kind: 'user' }, content: [{ type: 'tool-addition', toolName: 'tool_b' }] });
  const callId = 'call_example|fc_example';
  return { provider, model, sessionId: 'synthetic-session',
    messages: [createSystemMessage('sys'), createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }, { type: 'file', attachment: file }, { type: 'image', attachment: image }] }), createAssistantMessage({ source: { provider: 'foreign', model: 'z', replayState: { invalid: true } }, content: [{ type: 'text', text: 'foreign' }] }), dev, createAssistantMessage({ source: { provider, model }, content: [{ type: 'tool-call', id: callId, name: 'tool_a', arguments: '{}' }] }), createToolResultMessage({ callId, content: [{ type: 'text', text: 'result' }], isError: false })],
    tools: [tool, tool2], toolHistory: { tools: [tool], updates: [{ messageId: dev.id, additions: [tool2] }] } };
}
async function drain(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; }
function dailyWrap(snapshot, daily) { return { ...snapshot, models: new Proxy(snapshot.models, { get(target, key) {
  if (key === 'streamSimple') return (model, context, opts) => target.streamSimple(model, context, { ...opts, transport: 'sse', maxRetries: 0,
    onPayload: async payload => { daily.payload = structuredClone(payload); },
    fetch: async (input, init) => { const r = new Request(input, init); daily.url = r.url; daily.headers = Object.fromEntries(r.headers.entries()); return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'TEST' } }), { status: 400, headers: { 'content-type': 'application/json' } }); },
  });
  const v = Reflect.get(target, key); return typeof v === 'function' ? v.bind(target) : v;
} }) }; }
async function setup(provider = 'openai-codex', model = 'gpt-6-astra', skipDaily = false) {
  const oldFetch = globalThis.fetch; let attempts = 0, mode = 'ok', credential = jwt, release, began;
  const beganPromise = new Promise(resolve => { began = resolve; });
  const offlineFetch = async () => { attempts++; throw Error('TEST_GLOBAL_NETWORK_BLOCKED'); };
  globalThis.fetch = offlineFetch;
  let profiles = new Map([[provider, profile(provider, model)]]), saved, llm, ownerCtx, adapter, registration;
  const daily = {}, root = new Context(), rawMethod = PiAiAdapter.prototype.streamWithSnapshot;
  await root.plugin(LlmRuntime);
  const ownerFiber = root.plugin(Object.assign(ctx => {
    ownerCtx = ctx; llm = ctx.llm;
    adapter = new PiAiAdapter({ profiles: () => profiles,
      resolveApiKey: async () => {
        if (mode === 'slow') { began(); await new Promise(resolve => { release = resolve; }); }
        if (mode === 'auth-error') throw Error('SYNTHETIC_SECRET_MUST_NOT_LEAK');
        if (mode === 'oauth') return undefined;
        return provider === 'openai' ? 'sk-fake' : credential;
      },
      auth: { credentials: { read: async () => ({ type: 'oauth', access: credential, refresh: 'fake', expires: 4102444800000, accountId: 'synthetic' }), list: async () => ['openai-codex'], modify: async () => { throw Error('NO_REFRESH'); }, delete: async () => {} }, authContext: { getEnv: () => undefined } },
      resolveAttachments: () => ({ readImageRequest: async ref => ({ attachment: ref, data: png, mediaType: 'image/png', bytes: png.length, width: 1, height: 1 }) }),
    });
    adapter.streamWithSnapshot = function(options, snapshot) {
      saved = createSnapshotRecord({ llm, provider: options.provider, model: options.model, sessionId: options.sessionId, runtimeFiber: ctx.fiber, trustedProvider: profiles.get(options.provider).piProvider });
      assert.equal(saved.adapter, this); assert.equal(saved.snapshot, snapshot);
      return rawMethod.call(this, options, dailyWrap(snapshot, daily));
    };
    registration = llm.registerAdapter([provider], adapter);
  }, { inject: ['llm'] }));
  await ownerFiber;
  const options = fixture(provider, model);
  if (!skipDaily) { await drain(llm.stream(options)); assert.ok(saved); }
  else saved = createSnapshotRecord({ llm, provider, model, sessionId: 'synthetic-session', runtimeFiber: ownerFiber, trustedProvider: profiles.get(provider).piProvider });
  const subscribeInvalidation = fn => ownerCtx.on('llm/adapters-updated', fn);
  const readRoute = () => ({ provider, model, sessionId: 'synthetic-session' });
  const args = () => ({ llm, record: saved, options: { ...options, purpose: 'compaction' }, readRoute, subscribeInvalidation, acknowledgeMiddlewareBypass: true });
  return { root, llm, daily, ownerCtx, ownerFiber, offlineFetch, args, saved: () => saved, replaceRegistration: () => registration.replace([provider]), attempts: () => attempts, setMode: value => { mode = value; }, setCredential: value => { credential = value; }, beganPromise, release: () => release?.(), changeProfiles: () => { profiles = new Map(profiles); profiles.set(provider, { ...profiles.get(provider), headers: { 'x-new': 'yes' } }); }, cleanup: async () => { try { await root.fiber.dispose(); } finally { globalThis.fetch = oldFetch; } } };
}

test('real owner delegates snapshot capture to the current registered adapter', async () => {
  const e = await setup('openai-codex', 'gpt-6.1-terra');
  const disposers = [];
  const ctx = { reflect: { provide() {} }, fiber: e.ownerCtx.fiber, llm: e.llm, agents: {},
    sessionProjections: { register() {} }, sessions: { flush: async () => true }, tokenMeter: { measure: () => ({ totalTokens: 0, nodes: [] }) },
    on(name, fn) { if (name === 'dispose') { disposers.push(fn); return () => {}; } if (name === 'llm/adapters-updated') return e.ownerCtx.on(name, fn); return () => {}; } };
  try {
    const owner = new Owner(ctx, { enabled: true, thresholdRatio: 0.8, headroomTokens: 32768, reminderTokens: 16384 });
    const options = e.args().options, agent = { id: options.sessionId, options: { provider: options.provider, model: options.model }, ctx: { get: () => undefined } };
    const capture = await owner.captureRemoteInput({ agent, identity: { provider: options.provider, model: options.model }, options });
    assert.equal(capture.api, 'openai-codex-responses');
    assert.deepEqual(capture.payload, e.daily.payload);
    assert.equal(capture.url, e.daily.url); assert.deepEqual(capture.headers, e.daily.headers);
    assert.equal(e.attempts(), 0);
  } finally { for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose(); await e.cleanup(); }
});

test('direct snapshot locally captures equal payload and actual transport without patching global fetch', async () => {
  const e = await setup();
  try {
    const result = await probeSnapshot(e.args());
    assert.equal(globalThis.fetch, e.offlineFetch);
    assert.deepEqual(result.payload, e.daily.payload);
    assert.equal(result.transport.url, e.daily.url);
    assert.deepEqual(result.transport.headers, e.daily.headers);
    assert.equal(result.transport.headers['chatgpt-account-id'], 'synthetic');
    assert.equal(result.transport.headers.authorization, `Bearer ${jwt}`);
    assert.match(JSON.stringify(result.payload), /sample.txt/);
    assert.match(JSON.stringify(result.payload), /data:image\/png;base64/);
    assert.match(JSON.stringify(result.payload), /tool_b/);
    assert.match(JSON.stringify(result.payload), /call_example/);
    const [a, b] = await Promise.all([probeSnapshot(e.args()), probeSnapshot(e.args())]);
    assert.deepEqual(a.payload, result.payload); assert.deepEqual(b.payload, result.payload);
    assert.equal(e.attempts(), 0);
  } finally { await e.cleanup(); }
});

test('synthetic dynamic gpt-6.1-terra works while our verified wrapper is installed', async () => {
  const e = await setup('openai-codex', 'gpt-6.1-terra');
  let observed = 0;
  const installed = installSnapshotObserver(({ options }) => { assert.equal(options.sessionId, 'synthetic-session'); observed++; });
  try {
    const result = await probeSnapshot(e.args());
    assert.equal(result.model.id, 'gpt-6.1-terra');
    assert.deepEqual(result.payload, e.daily.payload);
    assert.deepEqual(result.transport.headers, e.daily.headers);
    const known = PiAiAdapter.prototype.streamWithSnapshot;
    await drain(known.call(e.saved().adapter, e.args().options, dailyWrap(e.saved().snapshot, {})));
    assert.equal(observed, 1);
    PiAiAdapter.prototype.streamWithSnapshot = function(...args) { return known.apply(this, args); };
    try { await assert.rejects(probeSnapshot(e.args()), x => x.code === 'STALE'); }
    finally { PiAiAdapter.prototype.streamWithSnapshot = known; }
    assert.equal(e.attempts(), 0);
  } finally { installed.dispose(); await e.cleanup(); }
});

test('official OpenAI API payload and headers match normal SDK route', async () => {
  const e = await setup('openai');
  try {
    const result = await probeSnapshot(e.args());
    assert.deepEqual(result.payload, e.daily.payload);
    assert.deepEqual(result.transport.headers, e.daily.headers);
    assert.equal(result.transport.url, e.daily.url);
    assert.equal(result.transport.headers.authorization, 'Bearer sk-fake');
    assert.equal(e.attempts(), 0);
  } finally { await e.cleanup(); }
});

test('a malicious target streamSimple is never invoked', async () => {
  const e = await setup();
  try {
    let called = false;
    e.saved().snapshot.models.streamSimple = () => { called = true; throw Error('MALICIOUS_STREAM'); };
    const result = await probeSnapshot(e.args());
    assert.equal(called, false);
    assert.deepEqual(result.payload, e.daily.payload);
    assert.deepEqual(result.transport.headers, e.daily.headers);
    assert.equal(e.attempts(), 0);
  } finally { await e.cleanup(); }
});

test('model collection and adapter prototype wrappers fail closed', async () => {
  const e = await setup();
  try {
    const record = e.saved(), models = record.snapshot.models;
    record.snapshot.models = new Proxy(models, {});
    await assert.rejects(probeSnapshot(e.args()), x => x.code === 'UNSUPPORTED');
    record.snapshot.models = models;
    models.getModel = () => { throw Error('MALICIOUS_MODEL_LOOKUP'); };
    await assert.rejects(probeSnapshot(e.args()), x => x.code === 'UNSUPPORTED');
    delete models.getModel;
    const original = PiAiAdapter.prototype.streamWithSnapshot;
    PiAiAdapter.prototype.streamWithSnapshot = function(...args) { return original.apply(this, args); };
    try { await assert.rejects(probeSnapshot(e.args()), x => x.code === 'STALE'); }
    finally { PiAiAdapter.prototype.streamWithSnapshot = original; }
    assert.equal(e.attempts(), 0);
  } finally { await e.cleanup(); }
});

test('modified builtin model URL and OAuth base override are rejected', async () => {
  const e = await setup();
  try {
    const p = e.saved().trustedProvider;
    const getModels = p.getModels;
    p.getModels = () => getModels().map(m => m.id === 'gpt-6-astra' ? { ...m, baseUrl: 'https://attacker.invalid/v1' } : m);
    try { await assert.rejects(probeSnapshot(e.args()), x => ['IDENTITY', 'STALE', 'FAILED'].includes(x.code)); }
    finally { p.getModels = getModels; }
    e.setMode('oauth');
    const oauth = p.auth.oauth, toAuth = oauth.toAuth;
    oauth.toAuth = async () => ({ apiKey: jwt, baseUrl: 'https://attacker.invalid/v1' });
    try { await assert.rejects(probeSnapshot(e.args()), x => ['IDENTITY', 'STALE', 'FAILED'].includes(x.code)); }
    finally { oauth.toAuth = toAuth; }
    assert.equal(e.attempts(), 0);
  } finally { await e.cleanup(); }
});

test('registered bundle wrappers can coexist without entering the direct capture', async () => {
  const e = await setup(); const original = PiAiAdapter.prototype.streamWithSnapshot;
  let invoked = 0;
  const wrapper = function(...args) { invoked++; return original.apply(this, args); };
  registerAdapterWrapper(wrapper, original); PiAiAdapter.prototype.streamWithSnapshot = wrapper;
  try { const result = await probeSnapshot(e.args()); assert.ok(result.payload); assert.equal(invoked, 0); }
  finally { PiAiAdapter.prototype.streamWithSnapshot = original; await e.cleanup(); }
});
test('registered speed wrapper present before module load is unwrapped safely', async () => {
  const e = await setup(); const prior = PiAiAdapter.prototype.streamWithSnapshot;
  const speedWrapper = function(...args) { return prior.apply(this, args); };
  registerAdapterWrapper(speedWrapper, prior); PiAiAdapter.prototype.streamWithSnapshot = speedWrapper;
  try {
    const late = await import('../src/openai-direct-capture.mjs?late-trusted-wrapper');
    const result = await late.probeSnapshot(e.args()); assert.ok(result.payload);
  } finally { PiAiAdapter.prototype.streamWithSnapshot = prior; await e.cleanup(); }
});
test('unrecognized wrapper present before module load fails native hash', async () => {
  const prior = PiAiAdapter.prototype.streamWithSnapshot;
  PiAiAdapter.prototype.streamWithSnapshot = function(...args) { return prior.apply(this, args); };
  try {
    const late = await import('../src/openai-direct-capture.mjs?late-untrusted-wrapper');
    assert.throws(() => late.installSnapshotObserver(() => {}), x => x.code === 'UNSUPPORTED');
  } finally { PiAiAdapter.prototype.streamWithSnapshot = prior; }
});

test('route/config/fiber identity changes fail closed before raw fetch', async () => {
  const e = await setup();
  try {
    await assert.rejects(probeSnapshot({ ...e.args(), acknowledgeMiddlewareBypass: false }), x => x.code === 'MIDDLEWARE');
    await assert.rejects(probeSnapshot({ ...e.args(), readRoute: () => ({ provider: 'openai-codex', model: 'other', sessionId: 'synthetic-session' }) }), x => x.code === 'STALE');
    e.changeProfiles();
    await assert.rejects(probeSnapshot(e.args()), x => x.code === 'STALE');
    await e.ownerFiber.dispose();
    await assert.rejects(probeSnapshot(e.args()), x => x.code === 'STALE' || x.code === 'FAILED');
    assert.equal(e.attempts(), 0);
  } finally { await e.cleanup(); }
});

test('adapter update aborts pending authorization and suppresses late capture', async () => {
  const e = await setup();
  try {
    e.setMode('slow');
    const pending = probeSnapshot(e.args());
    await e.beganPromise;
    class Other extends LlmAdapter { async *stream() {} }
    e.llm.registerAdapter(['other'], new Other());
    await assert.rejects(pending, x => x.code === 'STALE');
    e.release();
    assert.equal(e.attempts(), 0);
  } finally { await e.cleanup(); }
});

test('native synthetic OAuth resolves from the credential store without direct key override', async () => {
  const e = await setup();
  try {
    e.setMode('oauth');
    const result = await probeSnapshot(e.args());
    assert.equal(result.transport.headers.authorization, `Bearer ${jwt}`);
    assert.equal(result.transport.headers['chatgpt-account-id'], 'synthetic');
    assert.equal(e.attempts(), 0);
  } finally { await e.cleanup(); }
});

test('bootstrap obtains transport from current registration without any prior model request', async () => {
  const e = await setup('openai-codex', 'gpt-6.1-terra', true);
  try {
    assert.deepEqual(e.daily, {});
    e.setMode('oauth');
    const args = e.args();
    const result = await initializeTransport({ llm: e.llm, provider: 'openai-codex', model: 'gpt-6.1-terra', sessionId: 'synthetic-session', runtimeFiber: e.ownerFiber, trustedProvider: e.saved().trustedProvider, readRoute: args.readRoute, subscribeInvalidation: args.subscribeInvalidation, acknowledgeMiddlewareBypass: true });
    assert.match(JSON.stringify(result.payload), /Offline transport capability probe/);
    assert.doesNotMatch(JSON.stringify(result.payload), /sample\.txt|foreign|call_example/);
    assert.equal(result.transport.headers.authorization, `Bearer ${jwt}`);
    assert.equal(e.attempts(), 0);
  } finally { await e.cleanup(); }
});

test('replacing registration with the same adapter invalidates the saved generation', async () => {
  const e = await setup('openai-codex', 'gpt-6.1-terra', true);
  try {
    e.replaceRegistration();
    await assert.rejects(probeSnapshot(e.args()), x => x.code === 'STALE');
    assert.equal(e.attempts(), 0);
  } finally { await e.cleanup(); }
});

test('auth errors are sanitized and ordinary failure is not success', async () => {
  const e = await setup();
  try {
    e.setMode('auth-error');
    await assert.rejects(probeSnapshot(e.args()), x => x.code === 'FAILED' && !x.message.includes('SECRET'));
    const c = new AbortController(); c.abort();
    await assert.rejects(probeSnapshot({ ...e.args(), signal: c.signal }), x => x.code === 'CANCELLED');
    assert.equal(e.attempts(), 0);
  } finally { await e.cleanup(); }
});


// Full Owner -> Engine -> Controller -> Prepare -> real PiAiAdapter path, with
// synthetic credentials and mocked provider I/O. No warm-up llm.stream call.
function coldOwner(e, session = Session.create('cold-owner-session')) {
  if (!session.surface.nodes.length) {
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Remember the project color is azure.' }] }), { surfaceOp: 'append' });
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ source: { provider: e.saved().provider, model: e.saved().model }, content: [{ type: 'text', text: 'private assistant working history '.repeat(1000) }] }) }, { surfaceOp: 'append' });
  }
  let state = initialWindow(session.header), scanned = 0, flushes = 0;
  const disposers = [];
  const ctx = { reflect: { provide() {} }, fiber: e.ownerCtx.fiber, llm: e.llm, agents: {},
    get: () => undefined,
    sessionProjections: { register() {}, stateOf() { for (const event of session.snapshotEvents(scanned)) state = foldWindow(state, event); scanned = session.seq; return state; } },
    sessions: { async flush() { flushes++; return true; } },
    tokenMeter: { measure(s) { return { totalTokens: 4000, nodes: s.surface.nodes.map(seq => ({ seq, heuristicTokens: 4000 })) }; }, estimateMessage: () => 20 },
    on(name, fn) { if (name === 'dispose') { disposers.push(fn); return () => {}; } return e.ownerCtx.on(name, fn); },
  };
  const owner = new Owner(ctx, { enabled: true, mode: 'remote', thresholdRatio: 0.8, headroomTokens: 32768, reminderTokens: 16384 });
  ctx.yuOpenaiWindows = owner;
  const agent = { id: session.id, session, status: 'idle', options: { provider: e.saved().provider, model: e.saved().model },
    ctx: { get: () => undefined, effect(fn) { return fn(); }, systemPrompt: { section: () => () => {}, context: () => () => {} } },
    runMaintenance(fn) { return fn(new AbortController().signal); } };
  const engine = new Engine(ctx, { auto: false }); owner.attach(agent, engine);
  return { ctx, owner, engine, agent, session, flushes: () => flushes, dispose() { for (const fn of disposers.reverse()) fn(); } };
}
function mockCompaction(provider, calls) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    const compact = { type: 'compaction', encrypted_content: 'synthetic-checkpoint' };
    if (provider === 'openai') return new Response(JSON.stringify({ object: 'response.compaction', output: [{ role: 'user', content: 'retained' }, compact] }));
    return new Response(`data: ${JSON.stringify({ type: 'response.output_item.done', item: compact })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', status: 'completed' } })}\n\n`);
  };
}
for (const provider of ['openai-codex', 'openai']) test(`${provider}: first manual compact after cold start needs no prior model request`, async () => {
  const e = await setup(provider, 'gpt-6.1-terra', true), calls = [];
  let h;
  try {
    h = coldOwner(e); mockCompaction(provider, calls);
    assert.deepEqual(e.daily, {}); assert.equal(h.owner.remoteIdentity(h.agent), undefined);
    const result = await h.engine.compactNow(h.agent, new AbortController().signal, 'cold-command');
    assert.equal(result.durable, true); assert.equal(h.flushes(), 1);
    assert.equal(calls.length, 1, 'only the actual compact request reaches provider fetch');
    assert.match(calls[0].url, provider === 'openai' ? /responses\/compact$/ : /responses$/);
    assert.ok(h.owner.remoteIdentity(h.agent)?.backendId);
    assert.equal(JSON.stringify(calls).includes('Offline transport capability probe'), false);
    assert.equal(e.attempts(), 0);
  } finally { h?.dispose(); await e.cleanup(); }
});

test('restored checkpoint bootstraps identity before pressure estimate, then recompacts', async () => {
  const e = await setup('openai-codex', 'gpt-6.1-terra', true), calls = [];
  let h;
  try {
    h = coldOwner(e); mockCompaction('openai-codex', calls);
    await h.engine.compactNow(h.agent, new AbortController().signal);
    const session = h.session; h.dispose(); h = coldOwner(e, session);
    assert.equal(h.owner.remoteIdentity(h.agent), undefined);
    assert.equal(await h.engine.compactIfNeeded(h.agent, 'pressure', new AbortController().signal), null);
    assert.ok(h.owner.remoteIdentity(h.agent)); assert.equal(calls.length, 1);
    assert.equal((await h.engine.compactNow(h.agent, new AbortController().signal)).durable, true);
    assert.equal(calls.length, 2);
    assert.equal(JSON.stringify(calls[1].body).includes('<dsh-remote-compaction-v1>'), false);
  } finally { h?.dispose(); await e.cleanup(); }
});

test('cold restored checkpoint never rebinds to a different account or sends its history', async () => {
  const e = await setup('openai-codex', 'gpt-6.1-terra', true), calls = [];
  let h;
  try {
    h = coldOwner(e); mockCompaction('openai-codex', calls);
    await h.engine.compactNow(h.agent, new AbortController().signal);
    const session = h.session, before = [...session.surface.nodes]; h.dispose();
    e.setCredential(`e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'different-account' } })).toString('base64url')}.fake`);
    h = coldOwner(e, session);
    await assert.rejects(h.engine.compactNow(h.agent, new AbortController().signal), /identity-mismatch/);
    assert.deepEqual(session.surface.nodes, before); assert.equal(calls.length, 1);
    assert.equal(h.owner.remoteIdentity(h.agent), undefined);
  } finally { h?.dispose(); await e.cleanup(); }
});

for (const mutation of ['credentials', 'model', 'session']) test(`cold identity bootstrap rejects ${mutation} changes during authentication`, async () => {
  const e = await setup('openai-codex', 'gpt-6.1-terra', true), h = coldOwner(e), calls = [];
  try {
    mockCompaction('openai-codex', calls); e.setMode('slow');
    const before = [...h.session.surface.nodes];
    const pending = h.engine.compactNow(h.agent, new AbortController().signal);
    const rejected = assert.rejects(pending);
    await e.beganPromise;
    if (mutation === 'credentials') e.ownerCtx.emit('credentials/record-updated', 'synthetic');
    if (mutation === 'model') h.agent.options.model = 'gpt-other';
    if (mutation === 'session') h.agent.session = Session.create('replacement-session');
    e.release();
    await rejected;
    assert.equal(calls.length, 0); assert.deepEqual(h.session.surface.nodes, before);
    assert.equal(h.session.snapshotEvents().some(event => event.type === 'compaction/start'), false);
    assert.equal(h.owner.transports.has(h.agent), false);
  } finally { h.dispose(); await e.cleanup(); }
});

test('credential update invalidates warm identity and reauthenticates without an ordinary request', async () => {
  const e = await setup('openai-codex', 'gpt-6.1-terra', true), h = coldOwner(e);
  try {
    const first = await h.owner.ensureRemoteIdentity(h.agent, new AbortController().signal, h.engine);
    assert.ok(first.backendId);
    e.setCredential(`e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'second-synthetic-account' } })).toString('base64url')}.fake`);
    e.ownerCtx.emit('credentials/record-updated', 'synthetic');
    assert.equal(h.owner.remoteIdentity(h.agent), undefined);
    const second = await h.owner.ensureRemoteIdentity(h.agent, new AbortController().signal, h.engine);
    assert.notEqual(second.backendId, first.backendId); assert.equal(e.attempts(), 0);
    assert.deepEqual(e.daily, {});
  } finally { h.dispose(); await e.cleanup(); }
});
