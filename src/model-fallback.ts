import { join } from "node:path";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { fallbackRemoteInfo } from "./fallback-remote.js";
import {
  fallbackConfig,
  saveFallbackConfig,
  fallbackStateFile,
  quotaFile,
  routes,
  routeKey,
  sameRoute,
  quotaFailure,
  blockedRoute,
  makeBlock,
  type Route,
  type Block,
} from "./fallback-state.js";
import { dataDir, readJson, writeJson } from "./state.js";
type Selection = Route & { reasoningEffort?: string };
type SessionPreference = { preferred: Selection; automatic?: Selection };
export const name = "yu-model-fallback";
export const inject = ["llm", "typert", "sessionController"];

export class ModelFallback extends TypertRemoteService {
  private attempts = new WeakMap<object, { key: string; tried: Set<string> }>();
  private transitions = new WeakSet<object>();
  private switching = new Set<string>();
  private cursors = new Map<string, { route: Route; changedAt: number }>();
  private unsupportedWarned = new Set<string>();
  /**
   * 0.2.2-alpha.3 起宿主不再提供 `selectionFor(agent).assembled` 这个记账位
   * （它自己在 agent/pre-step 里比对 requestHeader 注入切换提示）。
   * 本插件仍需要知道“我已经把哪个选择折进过提示词装配”，所以自己持有。
   */
  private assembledMarker = new WeakMap<object, Selection>();
  constructor(ctx: any) {
    super(ctx, "yuModelFallback");
    ctx.effect(() =>
      ctx.typert.register({
        package: fallbackRemoteInfo.package,
        face: "host",
        schemas: [],
        invocations: fallbackRemoteInfo.descriptors,
        model: { services: [], events: [], objects: [] },
      }),
    );
    // DSH's native model-selection controller keeps prompt, pending selection,
    // durable request headers, and the UI on the same route. Do not call the
    // public selectModel API here: it also overwrites the user's global default.
    //
    // 0.2.2-alpha.3 适配（2026-11-04）：会话内选择不再挂在
    // `sessionController.agents.selectionFor()/selectForNextRequest()` 上（这两个方法
    // 已从 dsh-api-session-controller 移除），而是 Agent 自带的 `agent.model`
    // 这一面：`current()` 读「已记录的 pending ?? lastUsed，再退到实时路由」，
    // `select(route)` 追加一条 durable `model/selection` 事件、**不碰全局默认**，
    // 与旧的 selectForNextRequest 语义一致。宿主自己也在 agent/pre-step 里比较
    // requestHeader 并注入「模型已切换」提示，所以旧代码手写的 `assembled`
    // 记账不再需要（那是 rc.5 里宿主自己的字段）。
    // 构造期不再抛错：能力缺失改为在**首次遇到该形态的 agent 时**告警并跳过，
    // 这样扩展不会整条装配失败，功能也不会在支持的宿主上静默丢失。
    ctx.on(
      "system-prompt/assemble",
      async (_assembly: any, context: any, next: Function) => {
        const agent = context.agent;
        if (!this.managedAgent(agent) || !fallbackConfig().enabled)
          return next();
        const current = this.currentSelection(agent);
        if (current === undefined) return next();
        const preferred = this.preferred(agent, current);
        const selected = await this.choose(preferred, context.signal);
        if (selected && !sameRoute(current, selected))
          this.install(agent, selected);
        return next();
      },
      { prepend: true },
    );
    ctx.on(
      "agent/request",
      async (payload: any, next: Function) => {
        const proposed = await next();
        if (!this.managedAgent(payload.agent) || payload.signal.aborted)
          return proposed;
        const config = fallbackConfig();
        if (!config.enabled) return proposed;
        const current = this.currentSelection(payload.agent) ?? proposed;
        const preferred = this.preferred(payload.agent, current);
        const series = this.series(payload.agent, payload.turn, payload.step);
        const selected = await this.choose(
          preferred,
          payload.signal,
          series.tried,
        );
        if (!selected) return proposed;
        const changed = !sameRoute(proposed, selected);
        if (changed) this.install(payload.agent, selected);
        this.cursors.set(payload.agent.session.id, {
          route: selected,
          changedAt: Date.now(),
        });
        if (!changed && !this.transitions.has(payload.agent)) return proposed;
        this.transitions.delete(payload.agent);
        // Controls of the old model (including default maxTokens / effort) must
        // not be applied blindly to a different provider's model.
        const {
          reasoningEffort: _effort,
          maxTokens: _tokens,
          ...rest
        } = proposed;
        return { ...rest, ...selected };
      },
      { prepend: true },
    );
    ctx.on(
      "agent/request-error",
      async (payload: any, next: Function) => {
        if (
          !this.managedAgent(payload.agent) ||
          payload.signal.aborted ||
          !quotaFailure(payload.failure)
        )
          return next();
        const config = fallbackConfig();
        if (!config.enabled) return next();
        const failed = payload.agent.session.requestHeader()?.config;
        // An unlisted manually selected model is outside this fallback queue.
        // Do not mark it blocked or retry it through the configured models.
        if (
          !failed ||
          !routes(config).some((route) => sameRoute(route, failed))
        )
          return next();
        const current = this.currentSelection(payload.agent) ?? failed;
        const preferred = this.preferred(payload.agent, current);
        const series = this.series(payload.agent, payload.turn, payload.step);
        series.tried.add(routeKey(failed));
        const state = this.blocks();
        state[routeKey(failed)] = makeBlock(
          failed,
          payload.failure,
          this.snapshot(),
        );
        writeJson(fallbackStateFile, state);
        const selected = await this.choose(
          preferred,
          payload.signal,
          series.tried,
        );
        if (!selected || sameRoute(failed, selected) || payload.signal.aborted)
          return next();
        this.install(payload.agent, selected);
        return { kind: "retry" };
      },
      { prepend: true },
    );
    ctx.on("agent/disposed", ({ agent }: any) =>
      this.cursors.delete(agent.session.id),
    );
    ctx.on("session/event", (session: any, event: any) => {
      if (
        event.type !== "model/selection" ||
        this.switching.has(session.id) ||
        session.header.parentSession
      )
        return;
      const selected = this.selection(event.data);
      if (!selected) return;
      // Manual selection is the new preferred head even if the user selects
      // the same model that automatic fallback is currently using.
      this.remember(session.id, { preferred: selected });
      this.cursors.delete(session.id);
    });
  }
  /**
   * 读会话内当前选择（0.2.2 的 `agent.model.current()`）。
   * 形态不符（宿主太旧 / agent 还没发布 model 面）时告警一次并返回 undefined，
   * 调用方据此跳过本轮回退，而不是让整条 entry 装配失败。
   */
  private currentSelection(agent: any): Selection | undefined {
    const model = agent?.model;
    if (typeof model?.current !== "function") {
      this.warnUnsupported(agent);
      return undefined;
    }
    return this.selection(model.current());
  }
  private warnUnsupported(agent: any) {
    const id = String(agent?.session?.id ?? "(unknown)");
    if (this.unsupportedWarned.has(id)) return;
    this.unsupportedWarned.add(id);
    const warn = (this.ctx as any)?.logger?.warn?.bind((this.ctx as any).logger);
    const message =
      "yu-model-fallback: agent.model.current() 不可用，已跳过自动模型回退" +
      `（session=${id}；这通常意味着宿主 DSH 低于 0.2.2 或该 agent 未发布 model 面）`;
    if (warn) warn(message);
    else console.error(message);
  }
  /** 自有记账位的读口（装配与测试都用它，替代被宿主删除的 selection.assembled）。 */
  assembledOf(agent: any) {
    return this.assembledMarker.get(agent);
  }
  private managedAgent(agent: any) {
    return Boolean(agent?.session && !agent.session.header.parentSession);
  }
  private series(agent: object, turn: any, step: any) {
    const key = JSON.stringify([turn, step]);
    let current = this.attempts.get(agent);
    if (!current || current.key !== key) {
      current = { key, tried: new Set() };
      this.attempts.set(agent, current);
    }
    return current;
  }
  private blocks(): Record<string, Block> {
    return readJson(fallbackStateFile, {});
  }
  private snapshot() {
    return readJson(quotaFile, {});
  }
  private preferenceFile(id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid session ID");
    return join(dataDir, "model-fallback-sessions", `${id}.json`);
  }
  private selection(value: any): Selection | undefined {
    if (typeof value?.provider !== "string" || typeof value?.model !== "string")
      return undefined;
    return {
      provider: value.provider,
      model: value.model,
      ...(typeof value.reasoningEffort === "string"
        ? { reasoningEffort: value.reasoningEffort }
        : {}),
    };
  }
  private remember(id: string, value: SessionPreference) {
    writeJson(this.preferenceFile(id), value);
  }
  private preferred(
    agent: any,
    current: Selection | undefined,
  ): Selection | undefined {
    if (!current) return undefined;
    const saved: any = readJson(this.preferenceFile(agent.session.id), null);
    const preferred = this.selection(saved?.preferred);
    if (
      preferred &&
      (sameRoute(current, saved?.automatic) || sameRoute(current, preferred))
    )
      return preferred;
    const selected = this.selection(current)!;
    this.remember(agent.session.id, { preferred: selected });
    return selected;
  }
  private install(agent: any, route: Selection) {
    // 防御：宿主没有 agent.model.select 时不做切换（已在 currentSelection 里告警过）
    if (typeof agent?.model?.select !== "function") {
      this.warnUnsupported(agent);
      return;
    }
    const preferred = this.preferred(agent, this.currentSelection(agent)) ?? route;
    // Persist before emitting model/selection, so a restart cannot promote the
    // automatically selected backup into the user's preferred model.
    this.remember(agent.session.id, { preferred, automatic: route });
    this.switching.add(agent.session.id);
    try {
      // 0.2.2：会话内选择 = agent.model.select(route)（只追加 model/selection 事件）
      (agent as any).model.select(route);
    } finally {
      this.switching.delete(agent.session.id);
    }
    // 旧版这里写宿主字段 `selectionFor(agent).assembled = route`；0.2.2 宿主删掉了它，
    // 切换提示改由宿主在 agent/pre-step 比对 requestHeader 生成，本插件改用自有 WeakMap。
    this.assembledMarker.set(agent, route);
    this.transitions.add(agent);
    this.cursors.set(agent.session.id, { route, changedAt: Date.now() });
  }
  async choose(
    current: Selection | undefined,
    signal?: AbortSignal,
    tried = new Set<string>(),
  ): Promise<Selection | undefined> {
    const config = fallbackConfig();
    if (
      !config.enabled ||
      !current ||
      !routes(config).some((route) => sameRoute(route, current))
    )
      return undefined;
    const chain: Selection[] = [
      current,
      ...routes(config).filter((route) => !sameRoute(route, current)),
    ];
    const state = this.blocks(),
      snapshot = this.snapshot();
    const providers = new Set(
      (this.ctx as any).llm.listProviders().map((p: any) => p.id),
    );
    const catalogs = new Map<string, any[]>();
    for (const route of chain) {
      signal?.throwIfAborted();
      if (
        tried.has(routeKey(route)) ||
        blockedRoute(route, state, snapshot) ||
        !providers.has(route.provider)
      )
        continue;
      try {
        if (!catalogs.has(route.provider))
          catalogs.set(
            route.provider,
            await (this.ctx as any).llm.listModels(route.provider),
          );
        if (!catalogs.get(route.provider)!.some((m) => m.id === route.model))
          continue;
        const resolved = await (this.ctx as any).llm.resolveCallConfig(
          route,
          signal,
        );
        signal?.throwIfAborted();
        return {
          provider: resolved.provider,
          model: resolved.model,
          ...(resolved.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: resolved.reasoningEffort }),
        };
      } catch (error) {
        signal?.throwIfAborted();
        // Catalog disappearance / unsupported models are unavailable candidates,
        // not proof that the provider account has no quota.
      }
    }
    return undefined;
  }
  status() {
    const config = fallbackConfig();
    const blocks = this.blocks(),
      snapshot = this.snapshot();
    return JSON.parse(
      JSON.stringify({
        config,
        models: routes(config).map((route) => ({
          ...route,
          blocked: blockedRoute(route, blocks, snapshot) ?? null,
        })),
        cursors: [...this.cursors].map(([sessionId, cursor]) => ({
          sessionId,
          ...cursor,
        })),
      }),
    );
  }
  async catalog() {
    return {
      groups: await Promise.all(
        (this.ctx as any).llm.listProviders().map(async (p: any) => {
          try {
            return {
              id: p.id,
              name: p.name ?? p.label ?? p.id,
              models: (await (this.ctx as any).llm.listModels(p.id)).map(
                (m: any) => ({ id: m.id, name: m.name ?? m.id }),
              ),
            };
          } catch {
            return {
              id: p.id,
              name: p.name ?? p.label ?? p.id,
              models: [],
              error: "暂时无法读取模型",
            };
          }
        }),
      ),
    };
  }
  save(value: unknown) {
    saveFallbackConfig(value);
    return this.status();
  }
  retry(route: Route) {
    const blocks = this.blocks();
    delete blocks[routeKey(route)];
    writeJson(fallbackStateFile, blocks);
    return this.status();
  }
}
export function apply(ctx: any) {
  new ModelFallback(ctx);
}
