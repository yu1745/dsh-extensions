import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { getCodexAccountId } from "./vendor/shared/codex-api.js";
import { createHash } from "node:crypto";
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
/** Cordis fiber state that can serve injected services (`FiberState.ACTIVE`). */
const FIBER_ACTIVE = 2;
/**
 * Whether a plugin instance can still read its injected services.
 *
 * Cordis drops `fiber.store` the moment a plugin fiber leaves ACTIVE (reload,
 * preset-revision replacement, dependency churn), and any later read of an
 * injected service then throws `cannot get required service "..." in inactive
 * context`. Instances without a fiber (unit-test doubles) are trusted.
 */
export function engineIsLive(engine: any) {
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
  if (!entry || options.purpose || !entry.owner.enabled(options))
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
            entry.owner.transports.set(entry.agent, {
              baseURL: model.baseUrl,
              apiKey: streamOptions.apiKey,
              headers: { ...headers, "x-codex-turn-metadata": metadata },
              sessionId: state.sessionId,
              agentName: state.agentName,
              identity,
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
  static inject = ["agents", "sessionProjections", "llm"];
  static Config = z.object({
    enabled: z.boolean().default(true),
    thresholdRatio: z.number().min(0.1).max(0.95).default(0.8),
    headroomTokens: z.number().min(4096).step(1).default(32768),
    reminderTokens: z.number().min(1024).step(1).default(16384),
  });
  transports = new WeakMap<object, any>();
  private agents = new Map<
    string,
    { agent: any; engine: any; stop: () => void; tools: Function[] }
  >();
  constructor(
    ctx: any,
    public config: any,
  ) {
    super(ctx, "yuOpenaiWindows");
    ctx.sessionProjections.register(windowProjection);
    ctx.on("dispose", installWindowAdapter());
    ctx.on("agent/request", async ({ agent }: any, next: Function) => {
      const config = await next();
      if (
        this.agents.has(agent.id) &&
        this.state(agent).index > 0 &&
        !this.enabled(config)
      )
        throw new Error(
          "This session has OpenAI-only encrypted window checkpoints. Continue with an OpenAI model or start a new session for another provider; no inaccessible checkpoint will be sent silently.",
        );
      return config;
    });
    ctx.on("session/event", (session: any, event: any) => {
      if (event.type !== "model/selection") return;
      const item = this.agents.get(session.id);
      if (item) this.sync(item.agent, event.data);
    });
    ctx.on("dispose", () => {
      for (const item of [...this.agents.values()]) item.stop();
    });
  }
  enabled(route: any) {
    return this.config.enabled && isOpenaiRoute(route);
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
  attach(agent: any, engine: any) {
    const existing = this.agents.get(agent.id);
    if (existing) {
      if (existing.engine === engine) return;
      // A reloaded compaction instance (plugin reload, preset revision
      // replacement, dependency churn) takes the agent over: re-register the
      // window prompt/tools against the live engine instead of keeping a
      // reference whose Cordis context may already be inactive.
      this.detach(agent, existing.engine);
    }
    const item = { agent, engine, stop: () => {}, tools: [] as Function[] };
    this.agents.set(agent.id, item);
    owners.set(agent.id, { owner: this, agent, engine });
    const stop = agent.ctx.effect(() => {
      const section = agent.ctx.systemPrompt.section({
        name: "yu:openai-windows",
        order: 85,
        text: () => (this.enabled(currentRoute(agent)) ? WINDOW_GUIDANCE : ""),
      });
      const context = agent.ctx.systemPrompt.context({
        name: "yu:openai-window-budget",
        order: 85,
        required: true,
        text: () => {
          try {
            if (!this.enabled(currentRoute(agent))) return "";
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
        section();
        context();
        for (const d of item.tools.splice(0)) d();
        owners.delete(agent.id);
        if (this.agents.get(agent.id) === item) this.agents.delete(agent.id);
        this.transports.delete(agent);
      };
    });
    item.stop = stop;
  }
  /**
   * Drop the window prompt/tools for one Agent.
   *
   * Called by a disposing compaction instance and by {@link attach} while
   * replacing a stale engine. `engine` scopes the detach to that instance so a
   * late disposer cannot tear down a newer attachment.
   */
  detach(agent: any, engine?: any) {
    const item = this.agents.get(agent.id);
    if (!item) return;
    if (engine !== undefined && item.engine !== engine) return;
    this.agents.delete(agent.id);
    owners.delete(agent.id);
    this.transports.delete(agent);
    try {
      item.stop();
    } catch (error) {
      (this.ctx as any).logger?.warn?.(
        `yu-openai-windows: detach failed for ${agent.id}`,
        error,
      );
    }
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
      return engineIsLive(engine) ? engine : undefined;
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
    if (item && engineIsLive(item.engine)) return item.engine;
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
    const active = this.enabled(route);
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
            if (!this.enabled(currentRoute(agent)))
              throw new Error(
                "OpenAI window tools are disabled for the selected model",
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
            const result: any = await callWindowBackend(
              transport,
              schema.name,
              args,
              exec.signal,
            );
            if (
              !result ||
              (typeof result.encrypted_output !== "string" && !result.error)
            )
              throw new Error(
                "History/notes backend returned an invalid response",
              );
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
            !this.enabled(currentRoute(agent)) ||
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
