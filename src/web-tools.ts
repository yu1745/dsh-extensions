import z from "@deepseek-ai/schemastery";
import {
  applyWebSearchTool,
  applyWebFetchTool,
} from "@deepseek-ai/dsh-tool-web";
export const Config = z.object({
  root: z.boolean().default(false),
  search: z.boolean().default(true),
  fetch: z.boolean().default(true),
  searchMaxResults: z.number().default(8),
  searchMaxQueries: z.number().default(4),
  // DSH 0.2.2-alpha.3 起 dsh-tool-web 多了这条摘要预算（宿主默认 800）。
  searchSummaryMaxChars: z.number().default(800),
  searchTimeoutMs: z.number().default(60000),
  fetchTimeoutMs: z.number().default(30000),
  fetchMaxOutputChars: z.number().default(200000),
});
/**
 * 防漂移断言：`applyWebSearchTool` 是宿主的**内部位置参数**函数，宿主加参数时
 * 我们这里会静默错位（0.2.2 就这么炸过一次）。签名参数个数对不上就直接报错，
 * 让装配失败可见，而不是把布尔当毫秒传下去。
 */
function assertWebSearchArity(fn: any) {
  const expected = 6;
  if (typeof fn === "function" && fn.length !== expected)
    throw new Error(
      `yu-web-tools: dsh-tool-web applyWebSearchTool 签名变了（看到 ${fn.length} 个参数，按 ${expected} 个写的）：` +
        `需要按 (ctx, maxResults, maxQueries, summaryMaxChars, timeoutMs, fetchEnabled) 重新对账`,
    );
}

export const name = "yu-web-tools";
export const inject = ["tools", "web", "systemPrompt", "yuExtensions"];
// Every definition is registered in the original tool-web context: the headless
// root or an isolated Web preset. Presets without web tools receive none.
export function apply(ctx: any, config: any) {
  const mounted = new Map<string, { record: any; disposers: Function[] }>();
  function remove(kind: string) {
    for (const d of mounted.get(kind)?.disposers ?? []) d();
    mounted.delete(kind);
  }
  function add(kind: string, record: any) {
    const disposers: Function[] = [];
    if (record !== "builtin") {
      disposers.push(ctx.tools.register(record.tool));
      disposers.push(
        ctx.systemPrompt.section({
          name: `yu:${record.tool.name}`,
          order: 80,
          text: () => record.guidance,
        }),
      );
    } else {
      const proxy = Object.create(ctx);
      Object.defineProperty(proxy, "tools", {
        value: new Proxy(ctx.tools, {
          get: (target, key) =>
            key === "register"
              ? (tool: any) => {
                  const d = target.register(tool);
                  disposers.push(d);
                  return d;
                }
              : Reflect.get(target, key),
        }),
      });
      Object.defineProperty(proxy, "systemPrompt", {
        value: new Proxy(ctx.systemPrompt, {
          get: (target, key) =>
            key === "section"
              ? (section: any) => {
                  const d = target.section(section);
                  disposers.push(d);
                  return d;
                }
              : Reflect.get(target, key),
        }),
      });
      if (kind === "search") {
        // 注意参数位次：0.2.2-alpha.3 在 maxQueries 之后**插入了** summaryMaxChars
        // （宿主签名 applyWebSearchTool(ctx, maxResults, maxQueries, summaryMaxChars,
        // timeoutMs, fetchEnabled)）。上一版按 0.2.1 的位置传参，把布尔值当成了
        // timeoutMs ⇒ defineTool 直接报 "timeoutMs must be a positive finite number"，
        // 整个 preset 变 invalid。这里显式按新签名传，并留一条防漂移断言。
        assertWebSearchArity(applyWebSearchTool);
        applyWebSearchTool(
          proxy,
          config.searchMaxResults,
          config.searchMaxQueries,
          config.searchSummaryMaxChars,
          config.searchTimeoutMs,
          Boolean(config.fetch && !ctx.yuExtensions.active.reader),
        );
      } else {
        applyWebFetchTool(
          proxy,
          config.fetchTimeoutMs,
          config.fetchMaxOutputChars,
        );
      }
    }
    mounted.set(kind, { record, disposers });
  }
  function reconcile() {
    if (config.root && ctx.get("agentPresets")) {
      remove("search");
      remove("reader");
      return;
    }
    for (const kind of ["search", "reader"]) {
      const configured = kind === "search" ? config.search : config.fetch;
      const selected = ctx.yuExtensions.active[kind]
        ? ctx.yuExtensions.definitions.get(kind)
        : configured
          ? "builtin"
          : undefined;
      if (mounted.get(kind)?.record === selected) continue;
      remove(kind);
      if (selected) add(kind, selected);
    }
  }
  if (config.root)
    ctx.inject(["agentPresets"], () => {
      reconcile();
    });
  reconcile();
  ctx.on("yu-extensions/web-features", reconcile);
  ctx.on("dispose", () => {
    remove("search");
    remove("reader");
  });
}
