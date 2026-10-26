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
    const owner = ctx.sessionController.agents;
    if (
      typeof owner?.selectionFor !== "function" ||
      typeof owner?.selectForNextRequest !== "function"
    )
      throw new Error(
        "This DSH version does not expose session-local model selection for automatic fallback",
      );
    ctx.on(
      "system-prompt/assemble",
      async (_assembly: any, context: any, next: Function) => {
        const agent = context.agent;
        if (!this.managedAgent(agent) || !fallbackConfig().enabled)
          return next();
        const current = owner.selectionFor(agent).current;
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
        const current = owner.selectionFor(payload.agent).current ?? proposed;
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
        if (!failed) return next();
        const current = owner.selectionFor(payload.agent).current ?? failed;
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
    const owner = (this.ctx as any).sessionController.agents;
    const preferred =
      this.preferred(agent, owner.selectionFor(agent).current) ?? route;
    // Persist before emitting model/selection, so a restart cannot promote the
    // automatically selected backup into the user's preferred model.
    this.remember(agent.session.id, { preferred, automatic: route });
    this.switching.add(agent.session.id);
    try {
      owner.selectForNextRequest(agent, route);
    } finally {
      this.switching.delete(agent.session.id);
    }
    owner.selectionFor(agent).assembled = route;
    this.transitions.add(agent);
    this.cursors.set(agent.session.id, { route, changedAt: Date.now() });
  }
  async choose(
    current: Selection | undefined,
    signal?: AbortSignal,
    tried = new Set<string>(),
  ): Promise<Selection | undefined> {
    const config = fallbackConfig();
    if (!config.enabled || !current) return undefined;
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
