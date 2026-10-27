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
import {
  WINDOW_MARKER,
  checkpointReady,
  currentRoute,
  stableId,
} from "./openai-window-state.js";

/** Same transaction/locks as DSH; only OpenAI's policy and summary hook differ. */
export default class OpenaiWindowCompaction extends BasicCompactionEngine {
  static inject = [...BasicCompactionEngine.inject, "yuOpenaiWindows"];
  static Config = BasicCompactionEngine.Config;
  private capacities = new Map<string, { capacity: number; output: number }>();
  private reminders = new WeakMap<object, string>();
  constructor(ctx: any, config: any = {}) {
    super(ctx, config);
    ctx.on("agent/created", ({ agent }: any) => {
      ctx.yuOpenaiWindows.attach(agent, this);
    });
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
    const owner = (this.ctx as any).yuOpenaiWindows;
    if (!owner.enabled(currentRoute(agent)))
      return super.compactIfNeeded(agent, trigger, signal);
    owner.attach(agent, this);
    owner.sync(agent);
    signal.throwIfAborted();
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
    const state = owner.state(agent);
    if (state.pending) {
      if (!checkpointReady(state, state.pending.path))
        throw new Error(
          "OpenAI rollover checkpoint is no longer current; history retained. Save and read back a fresh checkpoint.",
        );
      const range = this.windowRange(agent.session);
      if (!range) return null;
      const result = await super.compactRegion(
        range.start,
        range.end,
        agent,
        signal,
      );
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
  compactNow(
    agent: any,
    signal: AbortSignal,
    sourceCommandId?: any,
  ): Promise<any> {
    const owner = (this.ctx as any).yuOpenaiWindows;
    if (!owner.enabled(currentRoute(agent)))
      return super.compactNow(agent, signal, sourceCommandId);
    if (!checkpointReady(owner.state(agent)))
      return Promise.reject(
        new ManualCompactionError(
          "summary",
          "OpenAI 使用滚窗而非摘要 compact。请先让模型写入并读回 checkpoint，再调用 new_context；当前历史保持不变。",
        ),
      );
    return agent.runMaintenance(async (maintenanceSignal: AbortSignal) => {
      const abort = AbortSignal.any([signal, maintenanceSignal]);
      abort.throwIfAborted();
      const range = this.windowRange(agent.session);
      if (!range) return null;
      let locked = false;
      for (const e of agent.session.snapshotEvents()) {
        if (e.type === "session/end-seed" || e.type === "compaction/end")
          locked = false;
        else if (e.type === "compaction/start") locked = true;
      }
      if (locked)
        throw new ManualCompactionError(
          "busy",
          "Window transition is already in progress",
        );
      const selected = [...agent.session.surface.nodes];
      const compactionId = CompactionId(randomUUID()),
        lifecycle = {
          compactionId,
          turn: null,
          ...(sourceCommandId ? { sourceCommandId } : {}),
        };
      const startEvent = agent.session.append("compaction/start", lifecycle);
      let closed = false,
        closing = false;
      try {
        const handoff = await this.summarize({}, agent, abort);
        abort.throwIfAborted();
        if (
          JSON.stringify(selected) !==
          JSON.stringify(agent.session.surface.nodes)
        )
          throw new Error(
            "Session changed while preparing a window handoff; history retained",
          );
        const shadowedSeqs = selected.slice(
          selected.indexOf(range.start),
          selected.indexOf(range.end) + 1,
        );
        const shadowedTokenCount = (this.ctx as any).tokenMeter
          .measure(agent.session)
          .nodes.filter((n: any) => shadowedSeqs.includes(n.seq))
          .reduce((n: number, x: any) => n + x.heuristicTokens, 0);
        const message = createUserMessage({
          content: handoff.summary,
          source: compactCheckpointSource(compactionId, sourceCommandId),
        });
        if (
          (this.ctx as any).tokenMeter.estimateMessage(message) >=
          shadowedTokenCount
        )
          throw new Error("History is too short for a useful window reset");
        const summaryEvent = agent.session.append("compaction/summary", {
          ...handoff,
          compactionId,
          ...(sourceCommandId ? { sourceCommandId } : {}),
          shadowedRange: range,
          shadowedSeqs,
          shadowedTokenCount,
        });
        agent.session.append("user/message", message, {
          surfaceOp: {
            op: "replace",
            startSeq: range.start,
            endSeq: range.end,
          },
          sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
        });
        closing = true;
        const endEvent = agent.session.append("compaction/end", lifecycle);
        closed = true;
        await (this.ctx as any).sessions.flush(agent.session);
        return {
          compactionId,
          startSeq: startEvent.seq,
          summarySeq: summaryEvent.seq,
          endSeq: endEvent.seq,
          summary: handoff.summary,
          shadowedRange: range,
          shadowedSeqs,
          shadowedTokenCount,
        };
      } catch (error) {
        if (!closed && !closing) {
          closing = true;
          agent.session.append("compaction/end", {
            ...lifecycle,
            error: errorChain(error),
          });
          await (this.ctx as any).sessions.flush(agent.session);
        }
        throw error;
      }
    });
  }
  compactRegion(
    start: any,
    end: any,
    agent: any,
    signal?: AbortSignal,
  ): Promise<any> {
    if (!(this.ctx as any).yuOpenaiWindows.enabled(currentRoute(agent)))
      return super.compactRegion(start, end, agent, signal);
    const range = this.windowRange(agent.session);
    if (!range || start !== range.start || end !== range.end)
      return Promise.reject(
        new Error(
          "OpenAI windows only reset the complete balanced conversation window",
        ),
      );
    return super.compactRegion(start, end, agent, signal);
  }
}
