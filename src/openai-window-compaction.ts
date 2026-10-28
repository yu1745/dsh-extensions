import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import {
  ManualCompactionError,
  CompactionId,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from "@deepseek-ai/dsh-compaction";
import { createUserMessage, errorChain } from "@deepseek-ai/dsh-llm";
import { randomUUID } from "node:crypto";
import { sameService } from "./cordis-service-identity.mjs";
import {
  WINDOW_MARKER,
  checkpointReady,
  currentRoute,
  isOpenaiRoute,
  stableId,
} from "./openai-window-state.js";

/** Same transaction/locks as DSH; only OpenAI's policy and summary hook differ. */
export default class OpenaiWindowCompaction extends BasicCompactionEngine {
  readonly [Symbol.for("@yu1745/dsh-extensions/openai-window-engine")] = true;
  static inject = [...BasicCompactionEngine.inject, "yuOpenaiWindows"];
  static Config = BasicCompactionEngine.Config;
  private capacities = new Map<string, { capacity: number; output: number }>();
  private reminders = new WeakMap<object, string>();
  /** Agents whose window prompt/tools this instance registered. */
  private served = new Set<any>();
  private manualBusy = new WeakSet<object>();
  private retired = false;
  isRetired() { return this.retired; }
  trackAgent(agent: any) { if (!this.retired) this.served.add(agent); }
  isCompactionBusy(agent: any) { return this.manualBusy.has(agent); }
  private trackMaintenance(agent: any, run: () => Promise<any>) {
    if (this.manualBusy.has(agent)) throw new ManualCompactionError("busy", "manual compaction already in progress");
    this.manualBusy.add(agent);
    const clear = () => {
      this.manualBusy.delete(agent);
      try { if (!this.retired) (this.ctx as any).yuOpenaiWindows?.onIdleBoundary?.(agent); } catch {}
    };
    try { return Promise.resolve(run()).finally(clear); }
    catch (error) { clear(); throw error; }
  }
  constructor(ctx: any, config: any = {}) {
    super(ctx, config);
    const owner = (this.ctx as any).yuOpenaiWindows;
    ctx.on("agent/created", ({ agent }: any) => {
      if (!this.serves(agent)) return;
      this.served.add(agent);
      owner.attach(agent, this);
    });
    // A reloaded or retired instance must give up its Agents: the composing
    // runtime keeps its records alive, and the owner re-attaches the engine
    // that is actually composed once this context is gone.
    ctx.on("dispose", () => {
      this.retired = true;
      for (const agent of this.served)
        try {
          owner.detach?.(agent, this);
        } catch {}
      this.served.clear();
    });
  }
  /**
   * Whether this instance owns an Agent's compaction.
   *
   * A preset-capable runtime mounts one engine per preset revision, and a
   * profile patch may also load this plugin at the root. Only the instance the
   * Agent's composition resolves to may attach, register window tools or drive
   * the automatic compaction listeners; the others stay passive so exactly one
   * engine serves an Agent and no stale instance is ever handed out.
   */
  serves(agent: any) {
    if (this.retired) return false;
    const presets = (this.ctx as any).get?.("agentPresets");
    if (!presets?.serviceFor) return true;
    try {
      const owner = presets.serviceFor(agent, "compaction");
      return owner === undefined || sameService(owner, this);
    } catch {
      return true;
    }
  }
  /** Refuse provider changes after an encrypted window checkpoint. */
  assertCompatibleRoute(owner: any, agent: any, route: any) {
    if (owner.hasRemoteCheckpoint?.(agent) && (!isOpenaiRoute(route) || owner.remoteMode?.(agent) !== true))
      throw new Error("Remote checkpoint cannot be passed to Basic compaction; history retained.");
    if (!isOpenaiRoute(route) && owner.state(agent).index > 0)
      throw new Error(
        "This session has OpenAI-only encrypted window checkpoints. Continue with an OpenAI model or start a new session; history retained.",
      );
    if (isOpenaiRoute(route) && owner.state(agent).index > 0 &&
        !owner.hasRemoteCheckpoint?.(agent) && !owner.enabled(route))
      throw new Error("OpenAI window checkpoint cannot use Basic compaction while windows are disabled; history retained.");
  }
  /** Stricter ownership check for fallback and for delegates before commit. */
  remoteServes(agent: any) {
    if (this.retired) return false;
    try {
      const fiber = (this.ctx as any).fiber;
      if (fiber !== undefined && (fiber.state !== 2 || fiber.uid === null)) return false;
      const presets = (this.ctx as any).get?.("agentPresets");
      if (!presets?.serviceFor) return true;
      return sameService(presets.serviceFor(agent, "compaction"), this);
    } catch {
      return false;
    }
  }
  /** Fail closed: a selected fallback must never become a Basic summary. */
  remoteMethod(owner: any, agent: any, method: string) {
    if (!this.remoteServes(agent)) throw new Error("Compaction engine is no longer active for this agent");
    const service = owner.remoteCompaction;
    if (typeof service?.[method] !== "function")
      throw new Error(`Remote compaction fallback is unavailable: missing ${method}`);
    return service[method].bind(service);
  }
  assertNoActiveCompaction(session: any) {
    let locked = false;
    for (const e of session.snapshotEvents()) {
      if (e.type === "session/end-seed" || e.type === "compaction/end") locked = false;
      else if (e.type === "compaction/start") locked = true;
    }
    if (locked) throw new ManualCompactionError("busy", "Compaction is already in progress");
  }
  assertRemoteTurn(session: any, manual: boolean) {
    const events = session.snapshotEvents();
    let open = false;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === "turn/start") { open = true; break; }
      if (events[i].type === "turn/end") break;
    }
    if (manual && open) throw new ManualCompactionError("busy", "manual compaction: the session already has an open turn");
    if (!manual && !open) throw new Error("compactRegion: no open turn for automatic compaction");
  }
  windowBudget(agent: any) {
    const route = currentRoute(agent),
      key = `${route?.provider}/${route?.model}`;
    const info = this.capacities.get(key);
    const meter = (this.ctx as any).tokenMeter.measure(agent.session);
    if (!info)
      return {
        remaining: null,
        capacity: null,
        used: meter.totalTokens,
        threshold: null,
      };
    const output =
      agent.options?.maxTokens ??
      agent.session.requestHeader()?.config.maxTokens ??
      info.output;
    const capacity = Math.max(0, info.capacity - output);
    return {
      remaining: Math.max(0, capacity - meter.totalTokens),
      capacity: info.capacity,
      used: meter.totalTokens,
      threshold: Math.max(
        0,
        Math.min(
          Math.floor(
            info.capacity *
              (this.ctx as any).yuOpenaiWindows.config.thresholdRatio,
          ),
          capacity - (this.ctx as any).yuOpenaiWindows.config.headroomTokens,
        ),
      ),
    };
  }
  async compactIfNeeded(
    agent: any,
    trigger: any,
    signal: AbortSignal,
  ): Promise<any> {
    // Preset-engine election: a passive instance must not run the OpenAI
    // window policy (or price anything) for an Agent another instance serves.
    if (!this.serves(agent)) return null;
    const owner = (this.ctx as any).yuOpenaiWindows;
    if (this.remoteServes(agent)) owner.attach?.(agent, this);
    const current = currentRoute(agent);
    this.assertCompatibleRoute(owner, agent, current);
    if (isOpenaiRoute(current) && owner.remoteMode?.(agent) === true) {
      signal.throwIfAborted();
      const remote = this.remoteMethod(owner, agent, "compactIfNeeded");
      this.assertNoActiveCompaction(agent.session);
      const result = await remote(agent, trigger, signal, this);
      signal.throwIfAborted();
      if (!this.remoteServes(agent)) throw new Error("Compaction engine is no longer active for this agent");
      return result;
    }
    if (!owner.enabled(current))
      return super.compactIfNeeded(agent, trigger, signal);
    owner.sync(agent);
    signal.throwIfAborted();
    if (owner.alphaActive?.(agent) === false) {
      if (trigger === "context-overflow") throw new Error("OpenAI window capability is not verified; history retained.");
      return null;
    }
    const route = currentRoute(agent),
      info = await (this.ctx as any).llm.resolveModelInfo(
        route.provider,
        route.model,
        signal,
      );
    if (info.context)
      this.capacities.set(`${route.provider}/${route.model}`, {
        capacity: info.context.contextWindow,
        output: info.defaultMaxTokens ?? 0,
      });
    signal.throwIfAborted();
    if (owner.alphaActive?.(agent) === false) throw new Error("OpenAI window capability changed; history retained.");
    const state = owner.state(agent);
    if (state.pending) {
      if (!checkpointReady(state, state.pending.path))
        throw new Error(
          "OpenAI rollover checkpoint is no longer current; history retained. Save and read back a fresh checkpoint.",
        );
      const range = this.windowRange(agent.session);
      if (!range) return null;
      const result = await this.alphaHandoff(agent, range, signal, "automatic");
      this.reminders.delete(agent);
      return result;
    }
    // No model-backed summarization, pruning or blind reset for OpenAI.
    if (trigger === "context-overflow")
      throw new Error(
        "OpenAI window overflowed without a verified handoff. History retained; no automatic summary or destructive reset was attempted.",
      );
    const budget = this.windowBudget(agent);
    if (
      budget.threshold !== null &&
      budget.used >= budget.threshold &&
      this.reminders.get(agent) !== state.windowId
    ) {
      this.reminders.set(agent, state.windowId);
      await owner.remind(
        agent,
        "The OpenAI context window is near its safe limit.",
      );
    }
    return null;
  }
  windowRange(session: any) {
    const nodes = session.surface.nodes;
    let start = 0;
    while (
      start < nodes.length &&
      session.eventAt(nodes[start]).type === "system/message"
    )
      start++;
    if (start >= nodes.length) return null;
    const first = nodes[start],
      last = nodes[nodes.length - 1];
    if (
      !toolPairingBalancedBefore(session, first) ||
      !toolPairingBalancedAfter(session, last)
    )
      return null;
    return { start: first, end: last };
  }
  async summarize(input: any, agent: any, signal?: AbortSignal): Promise<any> {
    const owner = (this.ctx as any).yuOpenaiWindows;
    if (!owner.enabled(currentRoute(agent)))
      return super.summarize(input, agent, signal);
    signal?.throwIfAborted();
    if (typeof owner.verifyHandoff !== "function" ||
        !(await owner.verifyHandoff(agent, signal ?? new AbortController().signal)))
      throw new Error("OpenAI handoff capability recheck failed; history retained.");
    signal?.throwIfAborted();
    const state = owner.state(agent);
    if (!checkpointReady(state, state.pending?.path))
      throw new Error(
        "OpenAI rollover requires a current successfully written and read-back checkpoint",
      );
    const path = state.checkpoint.path.startsWith("/")
      ? state.checkpoint.path
      : `${state.agentName}/notes/${state.checkpoint.path}`;
    const marker = {
      version: 1,
      ownerId: agent.id,
      sessionId: state.sessionId,
      windowId: stableId(`${agent.id}:${state.index + 1}:${agent.session.seq}`),
      index: state.index + 1,
      previousWindowId: state.windowId,
      backend: state.checkpoint.backend,
      checkpointPath: path,
    };
    const summary = [
      { type: "text", text: WINDOW_MARKER + JSON.stringify(marker) },
      {
        type: "text",
        text: `This is a fresh context window, not a conversation summary. Read checkpoint ${path} with notes_read_file before continuing. Previous context window ID: ${state.windowId}. Recover missing facts with history tools; the earlier conversation remains in the durable session log and remote history. Do not claim the task is complete merely because a window changed.`,
      },
    ];
    const route = currentRoute(agent);
    return { summary, provider: route.provider, model: route.model };
  }
  /**
   * Alpha handoff transaction. The recheck and both commit appends are one
   * synchronous critical section; no Basic summary hook can interleave there.
   */
  async alphaHandoff(agent: any, range: { start: any; end: any }, signal: AbortSignal,
    mode: "automatic" | "manual", sourceCommandId?: any): Promise<any> {
    signal.throwIfAborted();
    const engineCtx = this.ctx;
    const owner = (engineCtx as any).yuOpenaiWindows;
    const presetRegistry = (engineCtx as any).get?.("agentPresets");
    if (!this.remoteServes(agent) || !owner.alphaActive?.(agent) || owner.remoteMode?.(agent))
      throw new Error("OpenAI window capability or engine is unavailable; history retained.");
    this.assertNoActiveCompaction(agent.session);
    this.assertRemoteTurn(agent.session, mode === "manual");
    const session = agent.session;
    const selected = [...session.surface.nodes];
    const first = selected.indexOf(range.start), last = selected.indexOf(range.end);
    if (first < 0 || last < first || !toolPairingBalancedBefore(session, range.start) ||
        !toolPairingBalancedAfter(session, range.end))
      throw new Error("OpenAI window range is no longer balanced; history retained.");
    const shadowedSeqs = selected.slice(first, last + 1);
    const generation = session.surface.contentGeneration;
    const replaceGeneration = session.surface.replaceGeneration;
    const originalRoute = currentRoute(agent);
    const routeKey = JSON.stringify([originalRoute?.provider, originalRoute?.model]);
    const identity = owner.transports?.get(agent)?.identity;
    const originalState = owner.state(agent);
    const stateKey = (s: any) => JSON.stringify([s.index, s.windowId, s.backend,
      s.checkpoint, s.pending, s.lastInputSeq, s.lastWorkSeq]);
    const checkpoint = stateKey(originalState);
    if (!identity || !checkpointReady(originalState, originalState.pending?.path) ||
        originalState.checkpoint?.backend !== identity)
      throw new Error("OpenAI checkpoint identity or freshness unavailable; history retained.");
    const shadowedTokenCount = (this.ctx as any).tokenMeter.measure(session).nodes
      .filter((n: any) => shadowedSeqs.includes(n.seq))
      .reduce((n: number, x: any) => n + x.heuristicTokens, 0);
    let turn: any = null;
    if (mode === "automatic") {
      const events = session.snapshotEvents();
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === "turn/start") { turn = events[i].data.turn; break; }
        if (events[i].type === "turn/end") break;
      }
      if (turn === null) throw new Error("OpenAI automatic handoff requires an open turn");
    }
    const compactionId = CompactionId(randomUUID());
    const lifecycle = { compactionId, turn, ...(sourceCommandId ? { sourceCommandId } : {}) };
    const startEvent = session.append("compaction/start", lifecycle);
    let closed = false, closing = false;
    try {
      const handoff = await this.summarize({}, agent, signal);
      const message = createUserMessage({ content: handoff.summary,
        source: compactCheckpointSource(compactionId, sourceCommandId) });
      if ((this.ctx as any).tokenMeter.estimateMessage(message) >= shadowedTokenCount)
        throw new Error("History is too short for a useful window reset");
      // FINAL CHECK: all potentially asynchronous work has finished. No await or
      // user callback is permitted between this check and the two appends.
      signal.throwIfAborted();
      const activeRoute = currentRoute(agent);
      if (!this.remoteServes(agent) || this.ctx !== engineCtx ||
          !sameService((this.ctx as any).yuOpenaiWindows, owner) ||
          !sameService((engineCtx as any).get?.("agentPresets"), presetRegistry) ||
          !owner.alphaActive?.(agent) || owner.remoteMode?.(agent) ||
          JSON.stringify([activeRoute?.provider, activeRoute?.model]) !== routeKey ||
          owner.transports?.get(agent)?.identity !== identity ||
          stateKey(owner.state(agent)) !== checkpoint ||
          !checkpointReady(owner.state(agent), originalState.pending?.path) ||
          session.surface.contentGeneration !== generation ||
          session.surface.replaceGeneration !== replaceGeneration ||
          JSON.stringify([...session.surface.nodes]) !== JSON.stringify(selected) ||
          session.snapshotEvents(startEvent.seq + 1).some((e: any) =>
            ["turn/start", "turn/end", "session/end-seed", "compaction/start", "compaction/end"].includes(e.type)))
        throw new Error("OpenAI handoff state changed before commit; history retained.");
      const summaryEvent = session.append("compaction/summary", {
        ...handoff, compactionId, ...(sourceCommandId ? { sourceCommandId } : {}),
        shadowedRange: range, shadowedSeqs, shadowedTokenCount,
      });
      session.append("user/message", message, { surfaceOp: { op: "replace", startSeq: range.start, endSeq: range.end },
        sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs] });
      closing = true;
      const endEvent = session.append("compaction/end", lifecycle);
      closed = true;
      if (mode === "manual") await (this.ctx as any).sessions.flush(session);
      return { compactionId, startSeq: startEvent.seq, summarySeq: summaryEvent.seq,
        endSeq: endEvent.seq, summary: handoff.summary, shadowedRange: range,
        shadowedSeqs, shadowedTokenCount };
    } catch (error) {
      if (!closed && !closing) {
        closing = true;
        // Do not forge a close marker in a different turn or over a changed lock.
        // An unmatched start intentionally fails closed for the next attempt.
        const ownershipChanged = session.snapshotEvents(startEvent.seq + 1).some((e: any) =>
          ["turn/start", "turn/end", "session/end-seed", "compaction/start", "compaction/end"].includes(e.type));
        if (!ownershipChanged)
          session.append("compaction/end", { ...lifecycle, error: errorChain(error) });
        if (mode === "manual") await (this.ctx as any).sessions.flush(session);
      }
      throw error;
    }
  }
  compactNow(
    agent: any,
    signal: AbortSignal,
    sourceCommandId?: any,
  ): Promise<any> {
    if (this.retired) return Promise.reject(new Error("Compaction engine is retired"));
    const owner = (this.ctx as any).yuOpenaiWindows;
    if (this.remoteServes(agent)) owner.attach?.(agent, this);
    const current = currentRoute(agent);
    try {
      this.assertCompatibleRoute(owner, agent, current);
      if (isOpenaiRoute(current) && owner.remoteMode?.(agent) === true) {
        signal.throwIfAborted();
        const remote = this.remoteMethod(owner, agent, "compactNow");
        const remoteService = owner.remoteCompaction;
        // Reserve maintenance synchronously, as the native manual path does.
        // The delegate owns the transaction, but must not nest runMaintenance.
        try {
          return this.trackMaintenance(agent, () => agent.runMaintenance(async (maintenanceSignal: AbortSignal) => {
            const abort = AbortSignal.any([signal, maintenanceSignal]);
            try {
              abort.throwIfAborted();
              if (!this.remoteServes(agent)) throw new Error("Compaction engine is no longer active for this agent");
              if (!sameService((this.ctx as any).yuOpenaiWindows, owner) || owner.remoteCompaction !== remoteService ||
                  owner.remoteMode?.(agent) !== true || !isOpenaiRoute(currentRoute(agent)))
                throw new Error("Remote compaction route or service changed before maintenance");
              this.assertNoActiveCompaction(agent.session);
              this.assertRemoteTurn(agent.session, true);
              const result = await remote(agent, abort, sourceCommandId, this);
              abort.throwIfAborted();
              if (!this.remoteServes(agent)) throw new Error("Compaction engine is no longer active for this agent");
              return result;
            } catch (error) {
              if (maintenanceSignal.aborted && abort.reason === maintenanceSignal.reason)
                throw new ManualCompactionError("cancelled", "manual compaction was cancelled", { cause: error });
              abort.throwIfAborted();
              throw error;
            }
          }));
        } catch (error) {
          throw new ManualCompactionError("busy", "manual compaction requires an idle agent with no waking queued work", { cause: error });
        }
      }
    } catch (error) {
      return Promise.reject(error);
    }
    if (!owner.enabled(current))
      return super.compactNow(agent, signal, sourceCommandId);
    if (!checkpointReady(owner.state(agent)))
      return Promise.reject(
        new ManualCompactionError(
          "summary",
          "OpenAI 使用滚窗而非摘要 compact。请先让模型写入并读回 checkpoint，再调用 new_context；当前历史保持不变。",
        ),
      );
    return this.trackMaintenance(agent, () => agent.runMaintenance(async (maintenanceSignal: AbortSignal) => {
      const abort = AbortSignal.any([signal, maintenanceSignal]);
      abort.throwIfAborted();
      const range = this.windowRange(agent.session);
      if (!range) return null;
      return this.alphaHandoff(agent, range, abort, "manual", sourceCommandId);
    }));
  }
  compactRegion(
    start: any,
    end: any,
    agent: any,
    signal?: AbortSignal,
  ): Promise<any> {
    if (this.retired) return Promise.reject(new Error("Compaction engine is retired"));
    const owner = (this.ctx as any).yuOpenaiWindows;
    if (this.remoteServes(agent)) owner.attach?.(agent, this);
    const current = currentRoute(agent);
    try {
      this.assertCompatibleRoute(owner, agent, current);
      if (isOpenaiRoute(current) && owner.remoteMode?.(agent) === true) {
        signal?.throwIfAborted();
        const remote = this.remoteMethod(owner, agent, "compactRegion");
        this.assertNoActiveCompaction(agent.session);
        this.assertRemoteTurn(agent.session, false);
        const nodes = agent.session.surface.nodes;
        const first = nodes.indexOf(start), last = nodes.indexOf(end);
        if (first < 0 || last < first || !toolPairingBalancedBefore(agent.session, start) ||
            !toolPairingBalancedAfter(agent.session, end))
          throw new Error("Remote compaction requires a current balanced surface range");
        return Promise.resolve(remote(agent, start, end, signal, this)).then((result) => {
          signal?.throwIfAborted();
          if (!this.remoteServes(agent)) throw new Error("Compaction engine is no longer active for this agent");
          return result;
        });
      }
    } catch (error) {
      return Promise.reject(error);
    }
    if (!owner.enabled(current))
      return super.compactRegion(start, end, agent, signal);
    const range = this.windowRange(agent.session);
    if (!range || start !== range.start || end !== range.end)
      return Promise.reject(
        new Error(
          "OpenAI windows only reset the complete balanced conversation window",
        ),
      );
    return this.alphaHandoff(agent, range, signal ?? new AbortController().signal, "automatic");
  }
}
