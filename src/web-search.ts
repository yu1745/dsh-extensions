import z from "@deepseek-ai/schemastery";
import { createScope } from "@deepseek-ai/dsh-scope";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import register from "./vendor/web-search/index.js";
import {
  backends,
  configureBackend,
  getWebSearchBackend,
  setWebSearchBackend,
  type WebSearchBackend,
} from "./vendor/web-search/backend-config.js";
import { createBridge } from "./bridge.js";
import { searchRemoteInfo } from "./search-remote.js";
import {
  clearSearchOverrides,
  explicitSearchBackend,
  saveSearchBackend,
  searchBackendFor,
  searchOverrides,
} from "./search-context.js";
export const name = "yu-web-search";
export const inject = [
  "tools",
  "systemPrompt",
  "credentials",
  "yuExtensions",
  "agents",
  "commands",
  "typert",
];
export const Config = z.object({
  backend: z
    .union(["google", "openai", "deepseek", "minimax", "zai"])
    .default("google"),
});
type Record = { tool: any; guidance: string };
/** Settings-page face: the global default plus the per-session overrides. */
export class WebSearch extends TypertRemoteService {
  constructor(
    ctx: any,
    private readonly refresh: () => void,
  ) {
    super(ctx, "yuWebSearch");
    ctx.effect(() =>
      ctx.typert.register({
        package: searchRemoteInfo.package,
        face: "host",
        schemas: [],
        invocations: searchRemoteInfo.descriptors,
        model: { services: [], events: [], objects: [] },
      }),
    );
  }
  settings() {
    return {
      defaultBackend: getWebSearchBackend(),
      backends: [...backends],
      overrides: searchOverrides().map(({ sessionId, backend }) => ({
        sessionId,
        backend,
      })),
    };
  }
  setDefault(backend: WebSearchBackend) {
    setWebSearchBackend(backend);
    this.refresh();
    return this.settings();
  }
  clearOverrides() {
    clearSearchOverrides();
    this.refresh();
    return this.settings();
  }
}
export function apply(ctx: any, config: any) {
  configureBackend(config.backend);
  const records = new Map<WebSearchBackend, Record>();
  const bridges = backends.map((backend) => {
    const bridge = createBridge(ctx, {
      kind: "search",
      claim: false,
      commands: false,
      install(_kind: string, tool: any, guidance: string) {
        records.set(backend, { tool, guidance });
        return () => {};
      },
    });
    register(bridge as any, backend);
    return bridge;
  });
  const release = ctx.yuExtensions.claim("search");
  const initial = records.get(getWebSearchBackend())!;
  const uninstall = ctx.yuExtensions.install(
    "search",
    initial.tool,
    initial.guidance,
  );
  const mounted = new Map<
    any,
    {
      scope: any;
      backend: WebSearchBackend;
      target: WebSearchBackend;
      remove: () => void;
    }
  >();

  /** A session override wins; otherwise the parent's session and finally the global default. */
  function backendFor(agent: any): WebSearchBackend {
    const explicit = explicitSearchBackend(agent.session.id);
    if (explicit) return explicit;
    const parent = agent.session.header.parentSession;
    return parent ? searchBackendFor(parent) : getWebSearchBackend();
  }
  function attach(agent: any) {
    if (mounted.has(agent)) return mounted.get(agent);
    // Minimal/restricted presets must not acquire a search capability here.
    const visible = ctx.tools.get("web_search", agent);
    if (![...records.values()].some((r) => r.tool.execute === visible?.execute))
      return;
    const scope = createScope(ctx, agent);
    const backend = backendFor(agent);
    const state = {
      scope,
      backend,
      target: backend,
      remove: () => {},
    };
    mounted.set(agent, state);
    replace(state, backend);
    return state;
  }
  function replace(state: any, backend: WebSearchBackend) {
    const record = records.get(backend)!;
    state.remove();
    const removeTool = state.scope.ctx.tools.register(record.tool);
    const removePrompt = state.scope.ctx.systemPrompt.section({
      name: "yu:web_search",
      order: 80,
      text: record.guidance,
    });
    state.remove = () => {
      removePrompt();
      removeTool();
    };
    state.backend = backend;
    state.target = backend;
  }
  /**
   * Follow a changed global default. A running agent keeps its current tool
   * schema until the turn ends, so the model never receives arguments for a
   * schema it was not shown.
   */
  function refresh() {
    for (const [agent, state] of mounted) {
      state.target = backendFor(agent);
      if (agent.status === "idle" && state.backend !== state.target)
        replace(state, state.target);
    }
  }
  // The settings page edits the global default through this Remote service.
  new WebSearch(ctx, refresh);
  // 这两个事件传的是 `{ agent, … }` 载荷，不是 agent 本身。
  ctx.on("agent/created", ({ agent }: any) => {
    attach(agent);
  });
  ctx.on("agent/status", ({ agent, status }: any) => {
    const state = mounted.get(agent);
    if (state && status === "idle" && state.backend !== state.target)
      replace(state, state.target);
  });
  ctx.on("agent/disposed", async ({ agent }: any) => {
    const state = mounted.get(agent);
    mounted.delete(agent);
    await state?.scope.dispose();
  });
  for (const agent of ctx.agents.list()) attach(agent);
  // A per-session shortcut remains for one-off switches; the default and the
  // list of overrides live in Settings → 网页搜索.
  const unregisterCommand = ctx.commands.register({
    name: "websearch-backend",
    description: "仅切换当前会话的搜索后端，立即生效（全局默认在设置中修改）",
    input: {
      hint: "google | openai | deepseek | minimax | zai（不带参数显示当前会话后端）",
    },
    async handler({ agent, rawInput }: any) {
      const aliases: any = {
        codex: "openai",
        ds: "deepseek",
        mm: "minimax",
        bigmodel: "zai",
        "1": "google",
        on: "google",
        "0": "zai",
        off: "zai",
      };
      const raw = rawInput.trim().toLowerCase();
      const backend = aliases[raw] ?? raw;
      const own = explicitSearchBackend(agent.session.id);
      if (!raw)
        return {
          kind: "success",
          text: `当前会话搜索后端：${searchBackendFor(agent.session.id)}${own ? "（会话单独指定）" : "（跟随全局默认）"}。全局默认在 设置 → 网页搜索 中修改。`,
        };
      if (!backends.includes(backend))
        return {
          kind: "error",
          text: "无效搜索后端。请选择 google、openai、deepseek、minimax 或 zai。",
        };
      if (agent.status !== "idle")
        return { kind: "error", text: "请等当前回复完成后切换搜索后端。" };
      try {
        return await agent.runMaintenance(async () => {
          const state = attach(agent);
          if (!state)
            return {
              kind: "error",
              text: "当前会话未启用自定义网页搜索工具。",
            };
          if (state.backend !== backend) replace(state, backend);
          saveSearchBackend(agent.session.id, backend);
          return {
            kind: "success",
            text: `当前会话搜索后端已切换为 ${backend}，立即生效；其他会话不受影响（全局默认在设置中修改）。`,
          };
        });
      } catch (error: any) {
        return { kind: "error", text: error.message };
      }
    },
  });
  ctx.on("dispose", async () => {
    unregisterCommand();
    for (const state of mounted.values()) await state.scope.dispose();
    mounted.clear();
    uninstall();
    release();
    for (const bridge of bridges) await bridge.dispose();
  });
}
