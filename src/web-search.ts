import z from "@deepseek-ai/schemastery";
import { createScope } from "@deepseek-ai/dsh-scope";
import register from "./vendor/web-search/index.js";
import {
  backends,
  configureBackend,
  getWebSearchBackend,
  type WebSearchBackend,
} from "./vendor/web-search/backend-config.js";
import { createBridge } from "./bridge.js";
import {
  savedSearchBackend,
  searchBackendFor,
  saveSearchBackend,
} from "./search-context.js";
export const name = "yu-web-search";
export const inject = [
  "tools",
  "systemPrompt",
  "credentials",
  "yuExtensions",
  "agents",
  "commands",
];
export const Config = z.object({
  backend: z
    .union(["google", "openai", "deepseek", "minimax", "zai"])
    .default("google"),
});
type Record = { tool: any; guidance: string };
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
    { scope: any; backend: WebSearchBackend; remove: () => void }
  >();

  function attach(agent: any) {
    if (mounted.has(agent)) return mounted.get(agent);
    // Minimal/restricted presets must not acquire a search capability here.
    const visible = ctx.tools.get("web_search", agent);
    if (![...records.values()].some((r) => r.tool.execute === visible?.execute))
      return;
    const backend =
      savedSearchBackend(agent.session.id) ??
      (agent.session.header.parentSession
        ? searchBackendFor(agent.session.header.parentSession)
        : getWebSearchBackend());
    const scope = createScope(ctx, agent);
    const state = { scope, backend, remove: () => {} };
    mounted.set(agent, state);
    replace(state, backend);
    saveSearchBackend(agent.session.id, backend);
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
  }
  // 这两个事件传的是 `{ agent, … }` 载荷，不是 agent 本身。
  ctx.on("agent/created", ({ agent }: any) => {
    attach(agent);
  });
  ctx.on("agent/disposed", async ({ agent }: any) => {
    const state = mounted.get(agent);
    mounted.delete(agent);
    await state?.scope.dispose();
  });
  for (const agent of ctx.agents.list()) attach(agent);
  const unregisterCommand = ctx.commands.register({
    name: "websearch-backend",
    description: "切换当前会话搜索后端，立即生效",
    input: {
      hint: "google | openai | deepseek | minimax | zai（选中指令展开候选）",
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
      if (!raw)
        return {
          kind: "success",
          text: `当前会话搜索后端：${searchBackendFor(agent.session.id)}。选择候选项可立即切换。`,
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
            text: `当前会话搜索后端已切换为 ${backend}，立即生效。工具参数与提示词已同步更新。`,
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
