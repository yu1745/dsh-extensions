import { Service } from "@deepseek-ai/cordis";
import { sameService } from "./cordis-service-identity.mjs";
import z from "@deepseek-ai/schemastery";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { getCodexAccountId } from "./vendor/shared/codex-api.js";
import { createHash } from "node:crypto";
import { REMOTE_MARKER } from "./openai-remote-checkpoint-prototype.mjs";
import { RemoteCompactionController } from "./openai-remote-controller.mjs";
import { registerAdapterWrapper } from "./openai-adapter-chain.mjs";
import { createSnapshotRecord, probeSnapshot } from "./openai-direct-capture.mjs";
import { makeRemotePrepare, verifyRemoteOutput, extraRemoteCheckpointTokens } from "./openai-remote-prepare.mjs";
import {
  windowTools,
  callWindowBackend,
  transformWindowPayload,
} from "./openai-window-protocol.js";
import {
  WINDOW_STATE,
  WINDOW_GUIDANCE,
  checkpointReady,
  currentRoute,
  isOpenaiRoute,
  notePath,
  windowProjection,
} from "./openai-window-state.js";

export const name = "yu-openai-windows";
const owners = new Map<string, { owner: any; agent: any; engine: any }>();
type CapabilityState = {
  mode: "windows" | "remote";
  identity?: string;
  route?: string;
  generation: number;
  pendingSeries?: boolean;
};
// Survives owner reload for live Agents. Existing compressed checkpoints, not
// this cache or experimental fallback records, determine durable session pins.
const capabilityKey = Symbol.for("@yu1745/dsh-extensions/openai-window-capabilities");
const globalCapabilities: WeakMap<object, CapabilityState> =
  ((globalThis as any)[capabilityKey] ??= new WeakMap<object, CapabilityState>());
const routeKey = (route: any) => JSON.stringify([route?.provider, route?.model]);
const REMOTE_GUIDANCE = "Remote compaction mode is active. Earlier window reminders and instructions to save or recover notes, use history tools, or call new_context no longer apply. Do not use those tools; continue the user's task.";
function hasRemoteMarker(agent: any) {
  const session = agent?.session;
  return Boolean(session?.surface?.nodes?.some((seq: any) => {
    const event = session.eventAt(seq);
    return event?.type === "user/message" && event.data?.source?.kind === "compact-checkpoint" &&
      event.data?.content?.some((b: any) => b?.type === "text" && typeof b.text === "string" && b.text.startsWith(REMOTE_MARKER));
  }));
}
/** Cordis fiber state that can serve injected services (`FiberState.ACTIVE`). */
const FIBER_ACTIVE = 2;
const WINDOW_ENGINE = Symbol.for("@yu1745/dsh-extensions/openai-window-engine");
const isWindowEngine = (engine: any) => engine?.[WINDOW_ENGINE] === true;
/**
 * Whether a plugin instance can still read its injected services.
 *
 * Cordis drops `fiber.store` the moment a plugin fiber leaves ACTIVE (reload,
 * preset-revision replacement, dependency churn), and any later read of an
 * injected service then throws `cannot get required service "..." in inactive
 * context`. Instances without a fiber (unit-test doubles) are trusted.
 */
export function engineIsLive(engine: any) {
  if (engine?.isRetired?.()) return false;
  const fiber = engine?.ctx?.fiber;
  if (fiber === undefined) return engine !== undefined && engine !== null;
  return fiber.state === FIBER_ACTIVE && fiber.uid !== null;
}
let seamUsers = 0;
let restoreSeam: (() => void) | undefined;
export function backendIdentity(model: any, apiKey: string, headers: any = {}) {
  const account = getCodexAccountId(
    apiKey,
    headers["ChatGPT-Account-ID"] ?? headers["chatgpt-account-id"],
  );
  return createHash("sha256")
    .update(`${model.baseUrl}|${account ?? apiKey}`)
    .digest("hex");
}
export function snapshotWithWindows(snapshot: any, options: any) {
  const entry = owners.get(String(options.sessionId));
  if (entry) {
    entry.owner.assertRequestSafe(entry.agent);
    if (!options.purpose && !isOpenaiRoute(options) &&
        (entry.owner.hasRemoteCheckpoint(entry.agent) || entry.owner.state(entry.agent).index > 0))
      throw new Error("Encrypted context cannot be replayed on this provider; history retained.");
  }
  if (!entry || options.purpose ||
      (!entry.owner.enabled(options) && !entry.owner.hasRemoteCheckpoint(entry.agent)))
    return snapshot;
  return {
    ...snapshot,
    models: new Proxy(snapshot.models, {
      get(target, key) {
        if (key === "streamSimple")
          return (model: any, context: any, streamOptions: any) => {
            if (!streamOptions.apiKey)
              return (async function* () {
                streamOptions.signal?.throwIfAborted();
                const resolved = await target.getAuth(options.provider);
                streamOptions.signal?.throwIfAborted();
                if (!resolved?.auth?.apiKey)
                  throw new Error(
                    "OpenAI window authentication is unavailable",
                  );
                yield* snapshotWithWindows(
                  snapshot,
                  options,
                ).models.streamSimple(model, context, {
                  ...streamOptions,
                  apiKey: resolved.auth.apiKey,
                });
              })();
            if (
              !["openai-responses", "openai-codex-responses"].includes(
                model.api,
              )
            )
              throw new Error(
                "OpenAI rolling windows require the Responses protocol; configure a compatible route or disable yu-openai-windows.",
              );
            const state = entry.owner.state(entry.agent);
            const headers = {
              ...(model.headers ?? {}),
              ...(streamOptions.headers ?? {}),
            };
            const identity = backendIdentity(
              model,
              streamOptions.apiKey,
              headers,
            );
            const pinned =
              state.backend ??
              state.checkpoint?.backend ??
              state.pending?.backend;
            if (pinned && pinned !== identity)
              throw new Error(
                "OpenAI window checkpoint belongs to a different endpoint/account. Start a new session; existing history has not been sent to the new backend.",
              );
            const metadata = JSON.stringify({
              session_id: state.sessionId,
              thread_id: state.threadId,
              agent_name: state.agentName,
              window_id: `${state.threadId}:${state.index}`,
              window_number: state.index,
              context_window_id: state.windowId,
              request_kind: "turn",
              history_ingest_requested: true,
            });
            const account = getCodexAccountId(streamOptions.apiKey);
            if (account) headers["ChatGPT-Account-ID"] = account;
            entry.owner.recordTransport(entry.agent, {
              baseURL: model.baseUrl,
              apiKey: streamOptions.apiKey,
              headers: { ...headers, "x-codex-turn-metadata": metadata },
              sessionId: state.sessionId,
              agentName: state.agentName,
              identity,
            }, options);
            if (entry.owner.remoteMode(entry.agent))
              return target.streamSimple(model, context, {
                ...streamOptions,
                transport: "sse",
                headers,
                onPayload: async (payload: any, payloadModel: any) => {
                  const previous = await streamOptions.onPayload?.(payload, payloadModel);
                  const source = previous ?? payload;
                  // Old alpha tool outputs still need their encrypted transport
                  // representation, but remote mode stops history ingestion.
                  const transformed: any = transformWindowPayload(source, {
                    sessionId: state.sessionId, threadId: state.threadId,
                    windowId: `${state.threadId}:${state.index}`,
                    contextWindowId: state.windowId, windowNumber: state.index,
                    agentName: state.agentName,
                  });
                  const candidate = { ...source,
                    ...(Array.isArray(source.input) ? { input: transformed.input } : {}),
                    ...(Array.isArray(source.tools) ? { tools: transformed.tools } : {}),
                  };
                  if (!entry.owner.hasRemoteCheckpoint(entry.agent)) return candidate;
                  const replay = entry.owner.remoteCompaction?.replay;
                  if (typeof replay !== "function")
                    throw new Error("Remote checkpoint replay is unavailable; history retained.");
                  return replay.call(entry.owner.remoteCompaction, entry.agent, candidate, {
                    provider: options.provider, model: options.model, backendId: identity,
                  });
                },
              });
            return target.streamSimple(model, context, {
              ...streamOptions,
              transport: "sse",
              headers: {
                ...headers,
                "x-codex-window-id": `${state.threadId}:${state.index}`,
                "x-codex-turn-metadata": metadata,
              },
              onPayload: async (payload: any, payloadModel: any) => {
                const previous = await streamOptions.onPayload?.(
                  payload,
                  payloadModel,
                );
                return transformWindowPayload(previous ?? payload, {
                  sessionId: state.sessionId,
                  threadId: state.threadId,
                  windowId: `${state.threadId}:${state.index}`,
                  contextWindowId: state.windowId,
                  windowNumber: state.index,
                  agentName: state.agentName,
                });
              },
            });
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}
export function installWindowAdapter() {
  if (seamUsers++ === 0) {
    const prototype: any = PiAiAdapter.prototype,
      original = prototype.streamWithSnapshot;
    if (typeof original !== "function") {
      seamUsers--;
      throw new Error(
        "Unsupported DSH pi-ai adapter: missing streamWithSnapshot",
      );
    }
    const wrapped = function (this: any, options: any, snapshot: any) {
      return original.call(
        this,
        options,
        snapshotWithWindows(snapshot, options),
      );
    };
    registerAdapterWrapper(wrapped, original);
    prototype.streamWithSnapshot = wrapped;
    restoreSeam = () => {
      if (prototype.streamWithSnapshot === wrapped)
        prototype.streamWithSnapshot = original;
    };
  }
  return () => {
    if (--seamUsers === 0) {
      restoreSeam?.();
      restoreSeam = undefined;
    }
  };
}
export default class OpenaiWindows extends Service {
  static inject = ["agents", "sessionProjections", "llm", "sessions", "tokenMeter"];
  static Config = z.object({
    enabled: z.boolean().default(true),
    mode: z.union([z.const("windows"), z.const("remote")]).default("windows").volatile(),
    remoteSpeed: z.union([z.const("standard"), z.const("fast")]).default("standard").volatile(),
    thresholdRatio: z.number().min(0.1).max(0.95).default(0.8),
    headroomTokens: z.number().min(4096).step(1).default(32768),
    reminderTokens: z.number().min(1024).step(1).default(16384),
  });
  transports = new WeakMap<object, any>();
  /** Optional future implementation; absent means remote compaction fails closed. */
  remoteCompaction: any = undefined;
  private agents = new Map<
    string,
    { agent: any; engine: any; stop: () => void; tools: Function[] }
  >();
  constructor(
    ctx: any,
    public config: any,
  ) {
    super(ctx, "yuOpenaiWindows");
    const prepareRemote = makeRemotePrepare({
      ctx,
      capture: (request: any) => this.captureRemoteInput(request),
      validateCapture: (capture: any, identity: any) => this.validateRemoteCapture(capture, identity),
      transformAlphaInput: (payload: any, agent: any) => this.transformFallbackInput(payload, agent),
      needsRecovery: (agent: any) => this.needsRemoteRecovery(agent),
      openLease: (request: any) => this.openRemoteLease(request),
      fetch: (...args: any[]) => (globalThis.fetch as any)(...args),
    });
    const controller = new RemoteCompactionController({
      ctx,
      route: (agent: any) => currentRoute(agent),
      identity: (agent: any) => this.remoteIdentity(agent),
      initializeIdentity: (agent: any, signal: AbortSignal, engine: any) => this.ensureRemoteIdentity(agent, signal, engine),
      isActive: (agent: any, engine: any) => this.remoteMode(agent) && sameService(this.engineFor(agent), engine) && this.remoteCompaction === controller,
      needsRecovery: (agent: any) => this.needsRemoteRecovery(agent),
      prepare: prepareRemote,
      verifyCanonicalOutput: verifyRemoteOutput,
      extraTokens: (agent: any) => this.hasRemoteCheckpoint(agent) ? extraRemoteCheckpointTokens(agent, this.remoteIdentity(agent)) : 0,
      config,
    });
    this.remoteCompaction = controller;
    ctx.sessionProjections.register(windowProjection);
    ctx.on("dispose", installWindowAdapter());
    ctx.on("agent/request", async ({ agent }: any, next: Function) => {
      const config = await next();
      if (this.agents.has(agent.id)) {
        await this.checkpointBarrier(agent);
        this.assertRequestSafe(agent);
      }
      if (
        this.agents.has(agent.id) &&
        (this.state(agent).index > 0 || this.hasRemoteCheckpoint(agent)) &&
        !isOpenaiRoute(config)
      )
        throw new Error(
          "This session has OpenAI-only encrypted window checkpoints. Continue with an OpenAI model or start a new session for another provider; no inaccessible checkpoint will be sent silently.",
        );
      return config;
    });
    // Check the final stream route as well as agent/request: another waterfall
    // may choose a different provider after our request listener returns.
    ctx.on("llm/stream", async function* (options: any, next: Function) {
      const entry = owners.get(String(options.sessionId));
      if (entry && options.purpose === "compaction" &&
          (entry.owner.hasRemoteCheckpoint(entry.agent) || entry.owner.state(entry.agent).index > 0))
        throw new Error("An encrypted checkpoint cannot be compacted by a text summarizer; history retained.");
      if (entry && !options.purpose) {
        const owner = entry.owner;
        await owner.checkpointBarrier(entry.agent);
        owner.assertRequestSafe(entry.agent);
        const protectedHistory = owner.hasRemoteCheckpoint(entry.agent) || owner.state(entry.agent).index > 0;
        if (protectedHistory && !isOpenaiRoute(options))
          throw new Error("Encrypted context cannot be replayed on this provider; history retained.");
        if (owner.hasRemoteCheckpoint(entry.agent)) {
          const adapter = (owner.ctx as any).llm?.adapters?.get(options.provider)?.adapter;
          if (!(adapter instanceof PiAiAdapter))
            throw new Error("Remote checkpoint requires a compatible Responses adapter; history retained.");
        }
      }
      yield* next();
    });
    ctx.on("session/event", (session: any, event: any) => {
      const item = this.agents.get(session.id);
      if (!item || item.agent.session !== session) return;
      if (event.type === "step/start") this.capability(item.agent).pendingSeries = false;
      else if (event.type === "model/selection") {
        this.applyConfiguredMode(item.agent, event.data);
        this.sync(item.agent, event.data);
      }
    });
    // Transport identity is a derived cache, never proof that a previous
    // registration/account still owns the current route after auth changes.
    for (const event of ["llm/adapters-updated", "credentials/record-updated", "credentials/reference-updated"]) {
      ctx.on(event, () => {
        for (const { agent } of this.agents.values()) {
          if (this.remoteMode(agent)) this.transports.delete(agent);
        }
      });
    }
    ctx.on("settings/document-updated", () => {
      for (const { agent } of this.agents.values()) this.onIdleBoundary(agent);
    });
    ctx.on("agent/status", ({ agent, status }: any) => {
      if (status === "idle") this.onIdleBoundary(agent);
    });
    ctx.on("dispose", () => {
      for (const item of [...this.agents.values()]) item.stop();
    });
    // agent/created does not replay when this owner reloads. Install guards for
    // existing agents immediately, even if their preset engine is unavailable.
    for (const agent of ctx.agents.list?.() ?? []) this.attach(agent, this.resolveEngine(agent));
  }
  enabled(route: any) {
    return this.config.enabled && isOpenaiRoute(route);
  }
  remoteIdentity(agent: any) {
    const route = currentRoute(agent), transport = this.transports.get(agent);
    if (!isOpenaiRoute(route) || !transport?.identity ||
        (transport.route !== undefined && transport.route !== routeKey(route))) return undefined;
    return { provider: route.provider, model: route.model, backendId: transport.identity };
  }
  /** Establish auth from the live adapter, not from a previous model request.
   * The synthetic capture contains no session history and intercepts Responses
   * fetch locally; normal credential resolution may still refresh OAuth.
   */
  async ensureRemoteIdentity(agent: any, signal?: AbortSignal, engine?: any) {
    signal?.throwIfAborted();
    const existing = this.remoteIdentity(agent);
    if (existing) return existing;
    // A different selected route cannot inherit a cached backend identity.
    this.transports.delete(agent);
    if (!engine?.remoteServes?.(agent) || !sameService(this.engineFor(agent), engine))
      throw new Error("Remote compaction engine is no longer active");
    const selected = currentRoute(agent);
    const route = { provider: selected?.provider, model: selected?.model };
    if (!isOpenaiRoute(route)) throw new Error("Remote compaction route unavailable");
    const lease = this.openRemoteLease({ agent, identity: route, signal, bootstrap: true });
    try {
      const options = { ...route, sessionId: String(agent.id), purpose: "compaction",
        messages: [{ role: "user", content: [{ type: "text", text: "Offline transport capability probe." }] }], signal: lease.signal };
      const captured = await this.captureRemoteInput({ agent, identity: route, options, signal: lease.signal });
      lease.check(captured);
      const identity = this.capturedRemoteIdentity(captured, route);
      if (!identity) throw new Error("Remote compaction transport identity unavailable");
      // Durable records bind old ciphertext to its real account and route. Never
      // use a stored fingerprint as proof of current auth, or silently rebind it.
      if (this.hasRemoteCheckpoint(agent)) extraRemoteCheckpointTokens(agent, identity);
      lease.check(captured);
      this.recordTransport(agent, { identity: identity.backendId }, route);
      return identity;
    } finally { lease.dispose(); }
  }
  capturedRemoteIdentity(captured: any, route: any) {
    try {
      const headers = new Headers(captured?.headers), authorization = headers.get("authorization");
      if (!authorization?.startsWith("Bearer ")) return undefined;
      const identity = { provider: route.provider, model: route.model,
        backendId: backendIdentity(captured.model, authorization.slice(7), Object.fromEntries(headers)) };
      return this.validateRemoteCapture(captured, identity) ? identity : undefined;
    } catch { return undefined; }
  }
  needsRemoteRecovery(agent: any) {
    return this.state(agent).index > 0 && !this.hasRemoteCheckpoint(agent);
  }
  transformFallbackInput(payload: any, agent: any) {
    const state = this.state(agent);
    const transformed: any = transformWindowPayload(payload, {
      sessionId: state.sessionId, threadId: state.threadId,
      windowId: `${state.threadId}:${state.index}`, contextWindowId: state.windowId,
      windowNumber: state.index, agentName: state.agentName,
    });
    return { ...payload,
      ...(Array.isArray(payload.input) ? { input: transformed.input } : {}),
      ...(Array.isArray(payload.tools) ? { tools: transformed.tools } : {}),
    };
  }
  validateRemoteCapture(captured: any, identity: any) {
    try {
      if (!captured?.model || !captured?.headers || !captured?.url ||
          captured.model.provider !== identity.provider || captured.model.id !== identity.model ||
          captured.api !== captured.model.api) return false;
      const headers = new Headers(captured.headers);
      const authorization = headers.get("authorization");
      if (!authorization?.startsWith("Bearer ")) return false;
      return backendIdentity(captured.model, authorization.slice(7), Object.fromEntries(headers)) === identity.backendId;
    } catch { return false; }
  }
  /** Guard capture and remote fetch against route, owner and auth changes. */
  openRemoteLease({ agent, identity, signal, bootstrap = false }: any) {
    const ctx: any = this.ctx, fiber = ctx.fiber, llm = ctx.llm;
    const initialRoute = { ...currentRoute(agent) }, initialMode = this.configuredMode();
    const initialSpeed = this.configuredRemoteSpeed();
    const initialTransport = this.transports.get(agent), session = agent.session;
    if (bootstrap && (identity?.backendId !== undefined || initialTransport !== undefined))
      throw new Error("Remote identity bootstrap requires an empty transport cache");
    const item = this.agents.get(agent.id), engine = item?.engine;
    const registration = llm?.adapters?.get(identity?.provider), adapter = registration?.adapter;
    let snapshot: any;
    try { snapshot = adapter?.current?.(); } catch { throw new Error("Remote lease adapter is unavailable"); }
    if (!fiber || fiber.state !== FIBER_ACTIVE || fiber.uid == null || !item || !engine ||
        !registration || !adapter || !snapshot || typeof ctx.on !== "function")
      throw new Error("Remote lease prerequisites unavailable");
    const service = this.remoteCompaction, local = new AbortController();
    const combined = AbortSignal.any([local.signal, ...(signal ? [signal] : [])]);
    const disposers: Function[] = [];
    let disposed = false;
    const invalidate = () => local.abort();
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      local.abort();
      for (const stop of disposers.splice(0)) try { stop(); } catch {}
    };
    try {
      for (const event of ["llm/adapters-updated", "credentials/record-updated", "credentials/reference-updated", "dispose"]) {
        const stop = ctx.on(event, invalidate);
        if (typeof stop !== "function") throw new Error("Remote lease subscription unavailable");
        disposers.push(stop);
      }
      const stopSettings = ctx.on("settings/document-updated", (ns: string) => {
        if (ns === "yu-openai-windows") invalidate();
      });
      if (typeof stopSettings !== "function") throw new Error("Remote lease subscription unavailable");
      disposers.push(stopSettings);
      const stop = ctx.on("session/event", (session: any, event: any) => {
        if (session?.id === agent.session.id && event?.type === "model/selection") invalidate();
      });
      if (typeof stop !== "function") throw new Error("Remote lease subscription unavailable");
      disposers.push(stop);
      const check = (captured?: any) => {
        try {
          combined.throwIfAborted();
          const route = currentRoute(agent), transport = this.transports.get(agent);
          if (disposed || agent.session !== session || this.ctx !== ctx || ctx.fiber !== fiber || fiber.state !== FIBER_ACTIVE || fiber.uid == null ||
              this.agents.get(agent.id) !== item || !sameService(item.engine, engine) || !engineIsLive(engine) ||
              !engine.remoteServes?.(agent) || this.remoteCompaction !== service || !this.remoteMode(agent) ||
              this.configuredMode() !== initialMode || this.configuredRemoteSpeed() !== initialSpeed ||
               route?.provider !== initialRoute?.provider || route?.model !== initialRoute?.model ||
              route?.provider !== identity?.provider || route?.model !== identity?.model ||
               (bootstrap ? transport !== initialTransport : transport?.identity !== identity?.backendId) ||
              llm.adapters.get(identity.provider) !== registration || registration.adapter !== adapter || adapter.current() !== snapshot)
            throw new Error("invalid lease");
          if (captured !== undefined) {
            if (typeof captured?.checkSnapshot !== "function" ||
                !(bootstrap ? this.capturedRemoteIdentity(captured, identity) : this.validateRemoteCapture(captured, identity)))
              throw new Error("invalid capture");
            captured.checkSnapshot();
          }
        } catch {
          throw new Error("Remote lease invalidated; history retained.");
        }
      };
      check();
      return { signal: combined, check, dispose };
    } catch (error) {
      dispose();
      throw error;
    }
  }
  async captureRemoteInput({ agent, identity, options, signal }: any): Promise<any> {
    const llm: any = (this.ctx as any).llm;
    const adapter = llm?.adapters?.get(identity.provider)?.adapter;
    let provider: any;
    try {
      // The active configured provider is already trusted for ordinary requests;
      // bind this capture to that exact registration and reject changes.
      provider = adapter?.current?.()?.profiles?.get(identity.provider)?.piProvider;
    } catch {
      throw new Error("Remote compaction adapter snapshot is unavailable; history retained.");
    }
    const input = { llm, provider: identity.provider, model: identity.model,
      sessionId: String(agent.id), runtimeFiber: (this.ctx as any).fiber, trustedProvider: provider };
    const record = createSnapshotRecord(input);
    const checkSnapshot = () => {
      const current = createSnapshotRecord(input);
      if (current.registration !== record.registration || current.adapter !== record.adapter ||
          current.snapshot !== record.snapshot || current.modelFingerprint !== record.modelFingerprint ||
          current.rawMethod !== record.rawMethod || current.trustedProvider !== record.trustedProvider ||
          current.runtimeFiber !== (this.ctx as any).fiber)
        throw new Error("Remote capture snapshot changed; history retained.");
    };
    checkSnapshot();
    const result = await probeSnapshot({ llm, record, options,
      readRoute: () => ({ ...currentRoute(agent), sessionId: String(agent.id) }),
      subscribeInvalidation: (invalidate: Function) => this.ctx.on("llm/adapters-updated", invalidate as any),
      acknowledgeMiddlewareBypass: true,
      // Remote compaction has its own global speed, independent of /fast and
      // /ultrafast on the ordinary chat. Normal explicitly clears inherited tier.
      providerOptions: { serviceTier: this.configuredRemoteSpeed() === "fast" ? "priority" : undefined },
      signal,
    });
    checkSnapshot();
    return { ...result.transport, model: result.model, payload: result.payload, api: result.model.api, checkSnapshot };
  }
  state(agent: any) {
    const value = (this.ctx as any).sessionProjections.stateOf(
      agent.session,
      WINDOW_STATE,
    );
    if (!value)
      throw new Error("OpenAI window state projection is unavailable");
    return value;
  }
  configuredRemoteSpeed(): "standard" | "fast" {
    const field = this.config.remoteSpeed;
    const value = (field && typeof field.get === "function" ? field.get() : field) ?? "standard";
    if (value !== "standard" && value !== "fast") throw new Error("Invalid remote compaction speed");
    return value;
  }
  configuredMode(): "windows" | "remote" {
    const field = this.config.mode;
    const value = (field && typeof field.get === "function" ? field.get() : field) ?? "windows";
    if (value !== "windows" && value !== "remote") throw new Error("Invalid OpenAI context mode");
    return value;
  }
  private pinnedMode(agent: any): "windows" | "remote" | undefined {
    if (hasRemoteMarker(agent)) return "remote";
    if (this.state(agent).index > 0) return "windows";
    return undefined;
  }
  private capability(agent: any): CapabilityState {
    let value = globalCapabilities.get(agent);
    const pinned = this.pinnedMode(agent);
    if (!value || !["windows", "remote"].includes(value.mode)) {
      value = { mode: pinned ?? this.configuredMode(), generation: 0, pendingSeries: agent.session.seq > 0 };
      globalCapabilities.set(agent, value);
    } else if (pinned && value.mode !== pinned) {
      value.mode = pinned;
      value.generation++;
      value.pendingSeries = true;
    }
    return value;
  }
  /** Global selection and actual per-session mode may differ for safety. */
  modeStatus(agent: any) {
    const pin = this.pinnedMode(agent), effective = this.capability(agent).mode;
    return { configured: this.configuredMode(), effective, pinned: Boolean(pin),
      reason: pin === "remote" ? "remote-checkpoint" : pin === "windows" ? "window-checkpoint" : null,
      applies: isOpenaiRoute(currentRoute(agent)) };
  }
  hasRemoteCheckpoint(agent: any) { return hasRemoteMarker(agent); }
  remoteMode(agent: any) { return this.capability(agent).mode === "remote"; }
  alphaActive(agent: any) {
    return this.capability(agent).mode === "windows" && this.enabled(currentRoute(agent)) && Boolean(this.engineFor(agent));
  }
  /** Apply changes only while idle, never during an active turn or maintenance. */
  applyConfiguredMode(agent: any, route: any = currentRoute(agent)) {
    const value = this.capability(agent);
    if (agent.status !== "idle" || !isOpenaiRoute(route) || this.pinnedMode(agent) ||
        this.agents.get(agent.id)?.engine?.isCompactionBusy?.(agent)) return;
    let busy = false;
    for (const event of agent.session.snapshotEvents()) {
      if (event.type === "session/end-seed" || event.type === "compaction/end") busy = false;
      else if (event.type === "compaction/start") busy = true;
    }
    if (busy) return;
    const selected = this.configuredMode();
    if (value.mode !== selected) { value.mode = selected; value.generation++; value.pendingSeries = true; }
  }
  onIdleBoundary(agent: any) {
    if (!this.agents.has(agent.id) || agent.status !== "idle") return;
    this.applyConfiguredMode(agent);
    this.sync(agent);
  }
  assertRequestSafe(agent: any) {
    const hasCheckpoint = this.hasRemoteCheckpoint(agent);
    const engine = this.engineFor(agent);
    if ((hasCheckpoint || this.state(agent).index > 0) && !engine)
      throw new Error("Checkpoint compaction engine is unavailable; request blocked and history retained.");
    if (hasCheckpoint && typeof this.remoteCompaction?.replay !== "function")
      throw new Error("Remote checkpoint replay is unavailable; request blocked and history retained.");
    if (this.state(agent).index > 0 && !hasCheckpoint && !this.alphaActive(agent))
      throw new Error("Previous encrypted window cannot be recovered in the current mode; request blocked and history retained.");
  }
  async checkpointBarrier(agent: any) {
    if (!this.hasRemoteCheckpoint(agent)) return;
    if (typeof this.remoteCompaction?.ensureDurable !== "function")
      throw new Error("Remote checkpoint durability is unavailable; request blocked and history retained.");
    await this.remoteCompaction.ensureDurable(agent, true);
  }
  recordTransport(agent: any, transport: any, route: any) {
    const value = this.capability(agent);
    const state = this.state(agent);
    const pinned = state.backend ?? state.checkpoint?.backend ?? state.pending?.backend;
    if (pinned && pinned !== transport.identity)
      throw new Error("OpenAI checkpoint belongs to a different endpoint/account; history retained.");
    const key = routeKey(route);
    if (value.identity !== transport.identity || value.route !== key) {
      value.identity = transport.identity;
      value.route = key;
      value.generation++;
    }
    this.transports.set(agent, { ...transport, route: key });
    return false;
  }
  async verifyHandoff(agent: any, signal: AbortSignal) {
    signal.throwIfAborted();
    const state = this.state(agent), transport = this.transports.get(agent);
    const pinned = state.backend ?? state.checkpoint?.backend ?? state.pending?.backend;
    return Boolean(this.alphaActive(agent) && transport?.identity &&
      (!pinned || pinned === transport.identity));
  }
  attach(agent: any, engine: any) {
    if (!isWindowEngine(engine) || !engineIsLive(engine)) engine = undefined;
    const existing = this.agents.get(agent.id);
    if (existing) {
      if (sameService(existing.engine, engine)) return;
      // The agent-scoped guard outlives any individual compaction engine.
      // Rebind without removing tools or exposing an unguarded request gap.
      existing.engine = engine;
      owners.set(agent.id, { owner: this, agent, engine });
      engine?.trackAgent?.(agent);
      this.capability(agent).generation++;
      this.sync(agent);
      return;
    }
    const capability = this.capability(agent);
    capability.generation++;
    const item = { agent, engine, stop: () => {}, tools: [] as Function[] };
    this.agents.set(agent.id, item);
    owners.set(agent.id, { owner: this, agent, engine });
    engine?.trackAgent?.(agent);
    this.applyConfiguredMode(agent);
    const stop = agent.ctx.effect(() => {
      const preStep = agent.ctx.on?.("agent/pre-step", async (payload: any, next: Function) => {
        const decision = await next();
        if (decision?.kind !== "enter" || payload.agent !== agent) return decision;
        payload.signal.throwIfAborted();
        if (this.hasRemoteCheckpoint(agent)) {
          await this.checkpointBarrier(agent);
          this.assertRequestSafe(agent);
        }
        this.engineFor(agent);
        payload.signal.throwIfAborted();
        this.assertRequestSafe(agent);
        return this.capability(agent).pendingSeries ? { ...decision, startsRequestSeries: true } : decision;
      });
      const section = agent.ctx.systemPrompt.section({
        name: "yu:openai-windows",
        order: 85,
        text: () => this.alphaActive(agent) ? WINDOW_GUIDANCE :
          (isOpenaiRoute(currentRoute(agent)) && this.remoteMode(agent) &&
           (this.config.enabled || this.hasRemoteCheckpoint(agent)) ? REMOTE_GUIDANCE : ""),
      });
      const context = agent.ctx.systemPrompt.context({
        name: "yu:openai-window-budget",
        order: 85,
        required: true,
        text: () => {
          try {
            if (!this.alphaActive(agent)) return "";
            const state = this.state(agent);
            const budget = this.budgetFor(agent),
              remaining = budget?.remaining ?? null;
            return `<context_window>\nCurrent window: ${state.windowId}; index: ${state.index}. Estimated remaining tokens: ${remaining ?? "unknown"}.\n${remaining !== null && remaining <= this.config.reminderTokens ? "Window nearly full. Save and verify a checkpoint, then call new_context before doing further work." : ""}\n</context_window>`;
          } catch (error) {
            // A missing budget must never fail prompt assembly, and a turn must
            // never die because a plugin instance was reloaded underneath us.
            (this.ctx as any).logger?.warn?.(
              `yu-openai-windows: window budget unavailable for ${agent.id}`,
              error,
            );
            return "";
          }
        },
      });
      this.sync(agent);
      return () => {
        capability.generation++;
        if (typeof preStep === "function") preStep();
        section();
        context();
        for (const d of item.tools.splice(0)) d();
        if (sameService(owners.get(agent.id)?.owner, this) && owners.get(agent.id)?.agent === agent) owners.delete(agent.id);
        if (this.agents.get(agent.id) === item) this.agents.delete(agent.id);
        this.transports.delete(agent);
      };
    });
    item.stop = stop;
  }
  /** Retire an engine without removing the Agent's security registrations. */
  detach(agent: any, engine?: any) {
    const item = this.agents.get(agent.id);
    if (!item || (engine !== undefined && !sameService(item.engine, engine))) return;
    item.engine = undefined;
    for (const stop of item.tools.splice(0)) stop();
    const entry = owners.get(agent.id);
    if (sameService(entry?.owner, this)) entry.engine = undefined;
    this.capability(agent).generation++;
  }
  /**
   * Read the live `compaction` engine of an Agent's scoped composition.
   *
   * With agent presets, the effective engine lives inside the preset realm and
   * is not reachable from this root context; the registry publishes it per
   * Agent. Without presets (headless), no engine re-resolution is needed.
   */
  resolveEngine(agent: any) {
    const presets = (this.ctx as any).get?.("agentPresets");
    if (!presets?.serviceFor) return undefined;
    try {
      const engine = presets.serviceFor(agent, "compaction");
      return isWindowEngine(engine) && engineIsLive(engine) ? engine : undefined;
    } catch {
      return undefined;
    }
  }
  /**
   * The engine that may serve this Agent right now.
   *
   * A stale attachment is replaced by the currently composed engine, so a
   * reloaded plugin instance can never strand the Agent on a dead context.
   */
  engineFor(agent: any) {
    const item = this.agents.get(agent.id);
    if (item && isWindowEngine(item.engine) && engineIsLive(item.engine)) return item.engine;
    const next = this.resolveEngine(agent);
    if (next === undefined) return undefined;
    this.attach(agent, next);
    return next;
  }
  /** Safe window budget read: `null` when no live engine can answer. */
  budgetFor(agent: any) {
    const engine = this.engineFor(agent);
    if (engine === undefined) return null;
    try {
      return engine.windowBudget(agent);
    } catch (error) {
      (this.ctx as any).logger?.warn?.(
        `yu-openai-windows: window budget read failed for ${agent.id}`,
        error,
      );
      return null;
    }
  }
  sync(agent: any, route: any = currentRoute(agent)) {
    const item = this.agents.get(agent.id);
    if (!item) return;
    const active = this.enabled(route) && this.capability(agent).mode === "windows" && Boolean(this.engineFor(agent));
    if (!active) {
      for (const d of item.tools.splice(0)) d();
      return;
    }
    if (item.tools.length) return;
    // Encrypted function arguments require direct Responses tools, not JavaScript
    // embedded in run_code. Only this OpenAI agent uses native presentation.
    item.tools.push(agent.ctx.tools.presentAs("native"));
    const output = {
      schema: { type: "object", additionalProperties: true },
      render: (_args: any, v: any) => [
        { type: "text", text: JSON.stringify(v) },
      ],
      presentationMeta: (_args: any, v: any) =>
        v.state ? { yuOpenaiWindows: v.state } : {},
    };
    for (const schema of windowTools)
      item.tools.push(
        agent.ctx.tools.register({
          ...schema,
          output,
          finalizeContent: (_exec: any, result: any) =>
            result.isError ? undefined : output.render(null, result.value),
          timeoutMs: 40000,
          isConcurrencySafe: () =>
            !schema.name.endsWith("write_file") &&
            !schema.name.endsWith("append_to_file"),
          execute: async (args: any, exec: any) => {
            if (!this.alphaActive(agent))
              throw new Error(
                "OpenAI window tools are disabled for the current mode or model",
              );
            const state = this.state(agent),
              transport = this.transports.get(agent);
            if (!transport)
              throw new Error(
                "No authenticated Responses request for this window",
              );
            if (
              (state.backend ?? state.checkpoint?.backend) &&
              (state.backend ?? state.checkpoint?.backend) !==
                transport.identity
            )
              throw new Error(
                "Window backend identity changed; history retained",
              );
            if (
              schema.name === "notes_write_file" ||
              schema.name === "notes_append_to_file"
            ) {
              const path = notePath(state, args.path);
              if (!path.startsWith(`${state.agentName}/notes/`))
                throw new Error(
                  "Writes are limited to the current agent's notes directory",
                );
            }
            const result: any = await callWindowBackend(transport, schema.name, args, exec.signal);
            if (
              !result ||
              (!result.error && (typeof result.encrypted_output !== "string" || !result.encrypted_output.length))
            ) {
              throw new Error("History/notes backend returned an invalid response; history retained.");
            }
            if (result.error)
              throw new Error("History/notes backend rejected the operation");
            const kind =
              schema.name === "notes_write_file" ||
              schema.name === "notes_append_to_file"
                ? "write"
                : schema.name === "notes_read_file" &&
                    args.start_line == null &&
                    args.stop_line == null
                  ? "read"
                  : null;
            return {
              ...result,
              dshOpenaiWindowOutput: 1,
              ...(kind
                ? {
                    state: {
                      kind,
                      ownerId: agent.id,
                      windowId: state.windowId,
                      path: notePath(state, args.path),
                      backend: transport.identity,
                    },
                  }
                : {}),
            };
          },
        }),
      );
    item.tools.push(
      agent.ctx.tools.register({
        name: "get_context_remaining",
        description:
          "Return the estimated tokens remaining in this context window, its capacity and window ID. This is not an account quota query.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        output,
        execute: async () => ({
          ...((this.budgetFor(agent) as any) ?? {
            remaining: null,
            capacity: null,
            used: null,
            threshold: null,
          }),
          window_id: this.state(agent).windowId,
        }),
      }),
    );
    item.tools.push(
      agent.ctx.tools.register({
        name: "new_context",
        description:
          "Continue in a fresh context window using a saved checkpoint. The old conversation will not be carried forward. First write and read back the checkpoint in this window.",
        parameters: {
          type: "object",
          properties: {
            checkpoint_path: {
              type: "string",
              description:
                "Virtual note path successfully written and read back in the current window.",
            },
          },
          required: ["checkpoint_path"],
          additionalProperties: false,
        },
        output,
        execute: async (args: any) => {
          const state = this.state(agent);
          const path = notePath(state, args.checkpoint_path),
            transport = this.transports.get(agent);
          if (
            !this.alphaActive(agent) ||
            !transport ||
            transport.identity !== state.checkpoint?.backend ||
            !checkpointReady(state, path)
          )
            throw new Error(
              "Write and read back the checkpoint after the latest user message before starting a new window. Existing history was retained.",
            );
          return {
            scheduled: true,
            state: {
              kind: "rollover",
              ownerId: agent.id,
              windowId: state.windowId,
              path,
              backend: state.checkpoint.backend,
            },
          };
        },
      }),
    );
  }
  async remind(agent: any, reason: string) {
    agent.inject(
      createUserMessage({
        content: [
          {
            type: "text",
            text: `<context_window_reminder>${reason} Save the current goal, user constraints, decisions, progress, history references and next steps with notes_write_file/notes_append_to_file, read it back with notes_read_file, then call new_context with checkpoint_path. Do not continue ordinary work before that handoff.</context_window_reminder>`,
          },
        ],
        source: { kind: "system-prompt" },
      }),
    );
  }
}
