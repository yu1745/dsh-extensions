// Isolated, experimental direct PiAiAdapter snapshot probe; requires DSH private seams.
// It is NOT safe to use as an offline boundary for credential/OAuth resolution.
import { randomBytes, createHash } from 'node:crypto';
import { types } from 'node:util';
import { projectFilesToText, projectImagesForTextModel, projectToolUpdates } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { streamSimple as codexStream } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { streamSimple as openaiStream } from '@earendil-works/pi-ai/api/openai-responses';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { createModels } from '@earendil-works/pi-ai/models';
import { nativeAdapterMethod, registerAdapterWrapper } from './openai-adapter-chain.mjs';
// Known bundle wrappers are unwrapped; any unknown chain fails the fixed
// native-method fingerprint check before an auxiliary request is attempted.
const builtinAdapterPrototype = PiAiAdapter.prototype;
const builtinRawMethod = nativeAdapterMethod(builtinAdapterPrototype.streamWithSnapshot);
const builtinCurrent = builtinAdapterPrototype.current;
const builtinModelInfo = builtinAdapterPrototype.modelInfo;
const builtinModelOf = builtinAdapterPrototype.modelOf;
const builtinProfileOf = builtinAdapterPrototype.profileOf;
const NATIVE_HASH = 'db114b4004045176f02c3eef0964321fe61473f11cd82b3e7088e5d286fad09b';
const nativeHash = () => createHash('sha256').update(Function.prototype.toString.call(builtinRawMethod)).digest('hex');
const trustedHashes = new Map([
  [builtinCurrent, '3d2c542efa5d21f251491972e8f993fbc2ccb0a22b075bb238dcf80935a337d4'],
  [builtinModelInfo, 'fea69850653fdb4c47a5e32fd56a18740b02c375bbec9e3e9558b5c91fd19cd7'],
  [builtinModelOf, '01e7c9a2f9d5138a4e12c2820a23254695b22970ab7a178e337030d7f72a8669'],
  [builtinProfileOf, 'c940670333a16065f3256f714b72688d02b2afee6125dfa1a421f699c260a252'],
]);
let ownedObservation;
/** Install only this module's non-mutating wrapper on a verified native method. */
export function installSnapshotObserver(observe) {
  if (typeof observe !== 'function' || !verifiedMethod() || ownedObservation) throw problem('UNSUPPORTED', 'Native adapter or wrapper chain is not verified');
  let active = true;
  const parent = builtinAdapterPrototype.streamWithSnapshot;
  const wrapper = function(options, snapshot) {
    if (active) try { observe({ adapter: this, options, snapshot }); } catch { /* observation must not break an ordinary request */ }
    return parent.call(this, options, snapshot);
  };
  registerAdapterWrapper(wrapper, parent);
  ownedObservation = wrapper;
  builtinAdapterPrototype.streamWithSnapshot = wrapper;
  return { rawMethod: builtinRawMethod, dispose() {
    if (!active) return;
    active = false;
    if (builtinAdapterPrototype.streamWithSnapshot === wrapper) builtinAdapterPrototype.streamWithSnapshot = parent;
    ownedObservation = undefined;
  } };
}
const modelsPrototype = Object.getPrototypeOf(createModels());
const builtinGetAuth = modelsPrototype.getAuth;
const builtinGetModel = modelsPrototype.getModel;
const builtinGetModels = modelsPrototype.getModels;
function mergeHeaders(base, override) {
  if (!base && !override) return undefined;
  const result = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    for (const old of Object.keys(result)) if (old.toLowerCase() === key.toLowerCase()) delete result[old];
    result[key] = value;
  }
  return result;
}
function officialRoute(model) {
  if (!model || types.isProxy(model) || typeof model.id !== 'string' || !/^(?:gpt-[A-Za-z0-9][A-Za-z0-9._-]*|o[1-9][A-Za-z0-9._-]*|codex-[A-Za-z0-9][A-Za-z0-9._-]*)$/.test(model.id)) return false;
  if (!Array.isArray(model.input) || !model.input.includes('text') || model.input.some(x => x !== 'text' && x !== 'image')) return false;
  if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0 || !Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0) return false;
  return (model.provider === 'openai' && model.api === 'openai-responses') || (model.provider === 'openai-codex' && model.api === 'openai-codex-responses');
}
function officialBase(provider, baseUrl) {
  if (typeof baseUrl !== 'string') return false;
  const expected = provider === 'openai' ? 'https://api.openai.com/v1' : provider === 'openai-codex' ? 'https://chatgpt.com/backend-api' : '';
  return baseUrl === expected;
}
export class SnapshotProbeError extends Error {
  constructor(code, message) { super(message); this.name = 'SnapshotProbeError'; this.code = code; }
}
const problem = (code, message) => new SnapshotProbeError(code, message);
function verifiedMethod() {
  try {
    return nativeHash() === NATIVE_HASH && nativeAdapterMethod(builtinAdapterPrototype.streamWithSnapshot) === builtinRawMethod &&
      [...trustedHashes].every(([method, hash]) => createHash('sha256').update(Function.prototype.toString.call(method)).digest('hex') === hash);
  }
  catch { return false; }
}
function descriptorFingerprint(model) {
  return createHash('sha256').update(JSON.stringify(model)).digest('hex');
}
/**
 * Build a capture record directly from the current private LLM registration,
 * without an earlier model request. runtimeFiber is the calling plugin's active
 * fiber; trustedProvider must be authenticated by the caller's composition.
 * Neither proves the adapter's own fiber identity, which the registry omits.
 */
function createSnapshotRecordUnchecked({ llm, provider, model, sessionId, runtimeFiber, trustedProvider }) {
  if (!verifiedMethod() || !llm || !(llm.adapters instanceof Map) || !runtimeFiber || runtimeFiber.state !== 2 || runtimeFiber.uid == null || !trustedProvider || types.isProxy(trustedProvider) || !['openai', 'openai-codex'].includes(provider) || typeof model !== 'string' || !model || typeof sessionId !== 'string' || !sessionId) throw problem('UNSUPPORTED', 'Unverifiable runtime registration');
  const registration = llm.adapters.get(provider), adapter = registration?.adapter;
  if (!adapter || types.isProxy(adapter) || Object.getPrototypeOf(adapter) !== builtinAdapterPrototype || ['current', 'modelInfo', 'modelOf', 'profileOf'].some(k => Object.hasOwn(adapter, k)) || builtinAdapterPrototype.current !== builtinCurrent || builtinAdapterPrototype.modelInfo !== builtinModelInfo || builtinAdapterPrototype.modelOf !== builtinModelOf || builtinAdapterPrototype.profileOf !== builtinProfileOf) throw problem('UNSUPPORTED', 'Unverifiable adapter');
  const snapshot = adapter.current(), models = snapshot?.models;
  if (!snapshot || types.isProxy(snapshot) || !models || types.isProxy(models) || Object.getPrototypeOf(models) !== modelsPrototype || ['getAuth', 'getModel', 'getModels'].some(k => Object.hasOwn(models, k)) || modelsPrototype.getAuth !== builtinGetAuth || modelsPrototype.getModel !== builtinGetModel || modelsPrototype.getModels !== builtinGetModels || !(models.providers instanceof Map) || types.isProxy(models.providers) || models.providers.get(provider) !== trustedProvider) throw problem('UNSUPPORTED', 'Unverifiable provider snapshot');
  const descriptor = builtinGetModel.call(models, provider, model);
  if (!officialRoute(descriptor) || !officialBase(provider, descriptor.baseUrl)) throw problem('IDENTITY', 'Unsupported model route');
  if (llm.adapters.get(provider) !== registration || adapter.current() !== snapshot) throw problem('STALE', 'Adapter registration changed');
  return { adapter, snapshot, provider, model, sessionId, runtimeFiber, registration, modelFingerprint: descriptorFingerprint(descriptor), rawMethod: builtinRawMethod, adapterPrototype: builtinAdapterPrototype, trustedProvider };
}
export function createSnapshotRecord(options) {
  try { return createSnapshotRecordUnchecked(options); }
  catch (e) {
    const code = e instanceof SnapshotProbeError && ['UNSUPPORTED', 'IDENTITY', 'STALE'].includes(e.code) ? e.code : 'FAILED';
    throw problem(code, 'Unable to establish capture record');
  }
}
/** Bootstrap transport without sending or reading an old conversation pointer. */
export async function initializeTransport({ llm, provider, model, sessionId, runtimeFiber, trustedProvider, readRoute, subscribeInvalidation, acknowledgeMiddlewareBypass, signal, timeoutMs }) {
  const record = createSnapshotRecord({ llm, provider, model, sessionId, runtimeFiber, trustedProvider });
  const options = { provider, model, sessionId, purpose: 'compaction', messages: [{ role: 'user', content: [{ type: 'text', text: 'Offline transport capability probe.' }] }] };
  return probeSnapshot({ llm, record, options, readRoute, subscribeInvalidation, acknowledgeMiddlewareBypass, signal, timeoutMs });
}

/**
 * Capture a wire-ready ordinary Responses payload from an already-selected prefix.
 *
 * record must be produced by createSnapshotRecord with a trusted provider and a
 * live calling fiber. Registration identity and events do not prove adapter-fiber
 * ownership; an inactive adapter may still fail during credential resolution. This probe
 * intentionally bypasses llm/stream middleware and any other adapter wrappers;
 * the caller must establish separately that this is semantically acceptable.
 * Credential resolution/refresh happens BEFORE streamSimple/fetch interception;
 * it can access network. Caller must provide an independent offline boundary if
 * offline operation is required. Returned transport headers can include secrets.
 */
export async function probeSnapshot({ llm, record, options, readRoute, subscribeInvalidation, acknowledgeMiddlewareBypass, providerOptions = {}, signal, timeoutMs = 5000 }) {
  if (acknowledgeMiddlewareBypass !== true) throw problem('MIDDLEWARE', 'Direct dispatch bypasses middleware');
  if (!record || !llm || !options || typeof readRoute !== 'function' || typeof subscribeInvalidation !== 'function') throw problem('INPUT', 'Missing trusted capture prerequisites');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !providerOptions || typeof providerOptions !== 'object' ||
      Object.keys(providerOptions).some(key => key !== 'serviceTier') ||
      (providerOptions.serviceTier !== undefined && !['priority', 'ultrafast'].includes(providerOptions.serviceTier)))
    throw problem('INPUT', 'Invalid timeout or provider options');
  const { adapter, snapshot, provider, model, sessionId, runtimeFiber, registration: savedRegistration, modelFingerprint, rawMethod, adapterPrototype, trustedProvider } = record;
  if (!adapter || !snapshot || !runtimeFiber || !savedRegistration || typeof modelFingerprint !== 'string' || !adapterPrototype || !trustedProvider || types.isProxy(trustedProvider) || adapterPrototype !== builtinAdapterPrototype || rawMethod !== builtinRawMethod || nativeHash() !== NATIVE_HASH || ['current', 'modelInfo', 'modelOf', 'profileOf'].some(k => Object.hasOwn(adapter, k)) || types.isProxy(adapter) || types.isProxy(snapshot) || types.isProxy(snapshot.models) || Object.getPrototypeOf(adapter) !== adapterPrototype || Object.getPrototypeOf(snapshot.models) !== modelsPrototype || Object.hasOwn(snapshot.models, 'getAuth') || Object.hasOwn(snapshot.models, 'getModel') || Object.hasOwn(snapshot.models, 'getModels') || modelsPrototype.getAuth !== builtinGetAuth || modelsPrototype.getModel !== builtinGetModel || modelsPrototype.getModels !== builtinGetModels || !(snapshot.models.providers instanceof Map) || types.isProxy(snapshot.models.providers) || snapshot.models.providers.get(provider) !== trustedProvider || typeof rawMethod !== 'function' || typeof adapter.current !== 'function' || typeof adapter.modelInfo !== 'function' || !(llm.adapters instanceof Map) || typeof llm.normalizeModelInfo !== 'function' || typeof llm.resolveCallWithInfo !== 'function' || typeof llm.fileReadPath !== 'function') throw problem('UNSUPPORTED', 'Required trusted runtime seam unavailable');
  if (options.purpose !== 'compaction' || options.provider !== provider || options.model !== model || String(options.sessionId) !== String(sessionId)) throw problem('IDENTITY', 'Probe identity does not match captured route');
  let invalidated = false, active = true, timer, iterator, unsubscribe;
  const local = new AbortController();
  const combined = AbortSignal.any([local.signal, ...(signal ? [signal] : []), ...(options.signal ? [options.signal] : [])]);
  const check = () => {
    if (!active || combined.aborted) throw problem('CANCELLED', 'Probe cancelled');
    if (invalidated || runtimeFiber.state !== 2 || runtimeFiber.uid == null) throw problem('STALE', 'Runtime context is inactive or invalidated');
    if (!verifiedMethod() || builtinAdapterPrototype.current !== builtinCurrent || builtinAdapterPrototype.modelInfo !== builtinModelInfo || builtinAdapterPrototype.modelOf !== builtinModelOf || builtinAdapterPrototype.profileOf !== builtinProfileOf || Object.getPrototypeOf(snapshot.models) !== modelsPrototype || Object.hasOwn(snapshot.models, 'getAuth') || Object.hasOwn(snapshot.models, 'getModel') || Object.hasOwn(snapshot.models, 'getModels') || modelsPrototype.getAuth !== builtinGetAuth || modelsPrototype.getModel !== builtinGetModel || modelsPrototype.getModels !== builtinGetModels || snapshot.models.providers.get(provider) !== trustedProvider) throw problem('STALE', 'Adapter or auth implementation changed or is wrapped');
    const route = readRoute();
    if (!route || route.provider !== provider || route.model !== model || String(route.sessionId) !== String(sessionId)) throw problem('STALE', 'Agent route or session changed');
    const registration = llm.adapters.get(provider);
    if (!registration || registration !== savedRegistration || registration.adapter !== adapter || adapter.current() !== snapshot) throw problem('STALE', 'Adapter registration or snapshot changed');
    const descriptor = builtinGetModel.call(snapshot.models, provider, model);
    if (!officialRoute(descriptor) || !officialBase(provider, descriptor.baseUrl) || descriptorFingerprint(descriptor) !== modelFingerprint) throw problem('STALE', 'Model catalog descriptor changed');
    return registration;
  };
  const recordResult = {};
  const sentinel = `OFFLINE_SNAPSHOT_${randomBytes(24).toString('hex')}`;
  try {
    // Subscribe before checking to avoid an event/check gap. Caller owns listener scope.
    unsubscribe = subscribeInvalidation(() => { invalidated = true; local.abort(); });
    if (typeof unsubscribe !== 'function') throw problem('UNSUPPORTED', 'Invalid invalidation subscription');
    const registration = check();
    const info = llm.normalizeModelInfo(registration, model, adapter.modelInfo(snapshot, provider, model));
    const resolved = llm.resolveCallWithInfo(options, info).config;
    let messages = projectFilesToText(resolved.messages, ref => llm.fileReadPath(ref));
    if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) messages = projectImagesForTextModel(messages);
    const projected = projectToolUpdates(messages, resolved.tools, info.toolUpdate, resolved.toolHistory);
    messages = projected.messages.map(message => {
      if (message.role !== 'assistant' || message.source.replayState === undefined || llm.adapters.get(message.source.provider)?.adapter === adapter) return message;
      const { provider: p, model: m } = message.source;
      return { ...message, source: { kind: 'model', provider: p, model: m } };
    });
    const request = { ...resolved, messages, ...(projected.tools === undefined ? {} : { tools: projected.tools }), signal: combined };
    const wrapped = { ...snapshot, models: new Proxy(snapshot.models, { get(target, key) {
      if (key !== 'streamSimple') { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; }
      return (modelInfo, context, streamOptions) => {
        check();
        if (modelInfo.provider !== provider || modelInfo.id !== model || !officialRoute(modelInfo) || !officialBase(provider, modelInfo.baseUrl) || streamOptions.onPayload !== undefined || streamOptions.transformHeaders !== undefined) throw problem('IDENTITY', 'Untrusted model or stream wrapper');
        return (async function* () {
          // Match ModelsImpl.applyAuth, including resolution for explicit apiKey.
          // getAuth can refresh OAuth over network; trustedProvider is a caller trust boundary.
          const resolution = await builtinGetAuth.call(target, modelInfo, { apiKey: streamOptions.apiKey, env: streamOptions.env, signal: streamOptions.signal });
          check();
          if (!resolution?.auth?.apiKey) throw problem('FAILED', 'Provider credential unavailable');
          const auth = resolution.auth;
          const requestModel = auth.baseUrl ? { ...modelInfo, baseUrl: auth.baseUrl } : modelInfo;
          if (!officialBase(provider, requestModel.baseUrl)) throw problem('IDENTITY', 'Unsupported authentication endpoint');
          const headers = mergeHeaders(auth.headers, streamOptions.headers);
          const env = resolution.env || streamOptions.env ? { ...(resolution.env ?? {}), ...(streamOptions.env ?? {}) } : undefined;
          const official = modelInfo.api === 'openai-codex-responses' && provider === 'openai-codex' ? codexStream : modelInfo.api === 'openai-responses' && provider === 'openai' ? openaiStream : undefined;
          if (!official) throw problem('IDENTITY', 'Unsupported official API route');
          const stream = official(requestModel, normalizeContext(context), {
            ...streamOptions, ...providerOptions, apiKey: streamOptions.apiKey ?? auth.apiKey, headers, env, transport: 'sse', maxRetries: 0,
            onPayload: async payload => {
              check();
              recordResult.payload = structuredClone(payload);
              recordResult.model = structuredClone(requestModel);
            },
            fetch: async (input, init) => {
              check();
              if (!recordResult.payload) throw problem('INVALID', 'Transport reached before payload capture');
              const req = new Request(input, init);
              recordResult.transport = { url: req.url, method: req.method, headers: Object.fromEntries(req.headers.entries()) };
              return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: sentinel } }), { status: 400, headers: { 'content-type': 'application/json' } });
            },
          });
          yield* stream;
        })();
      };
    } }) };
    const consume = async () => {
      iterator = rawMethod.call(adapter, request, wrapped)[Symbol.asyncIterator]();
      let finish;
      while (true) { const item = await iterator.next(); if (item.done) break; if (item.value?.type === 'finish') finish = item.value; }
      check();
      if (!recordResult.transport || finish?.reason?.kind !== 'error' || !finish.reason.failure?.message?.includes(sentinel)) throw problem('FAILED', 'Probe did not complete its synthetic transport');
      return recordResult;
    };
    let timeoutTriggered = false;
    const waitTimeout = new Promise((_, reject) => { timer = setTimeout(() => { timeoutTriggered = true; local.abort(); reject(problem('TIMEOUT', 'Probe timed out')); }, timeoutMs); });
    const waitAbort = new Promise((_, reject) => { const abort = () => reject(problem(invalidated ? 'STALE' : timeoutTriggered ? 'TIMEOUT' : 'CANCELLED', 'Probe cancelled')); if (combined.aborted) abort(); else combined.addEventListener('abort', abort, { once: true }); });
    const result = await Promise.race([consume(), waitTimeout, waitAbort]);
    check();
    return result;
  } catch (e) {
    if (invalidated) throw problem('STALE', 'Adapter ownership changed');
    if (e instanceof SnapshotProbeError && ['CANCELLED', 'STALE', 'UNSUPPORTED', 'IDENTITY', 'INVALID', 'TIMEOUT', 'FAILED'].includes(e.code)) throw problem(e.code, 'Probe failed or was cancelled');
    throw problem('FAILED', 'Probe failed before synthetic transport');
  } finally {
    active = false; clearTimeout(timer); local.abort();
    try { unsubscribe?.(); } catch { /* no secrets in diagnostics */ }
    if (iterator?.return) Promise.resolve().then(() => iterator.return()).catch(() => {});
  }
}
