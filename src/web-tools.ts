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
  searchTimeoutMs: z.number().default(60000),
  fetchTimeoutMs: z.number().default(30000),
  fetchMaxOutputChars: z.number().default(200000),
});
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
      if (kind === "search")
        applyWebSearchTool(
          proxy,
          config.searchMaxResults,
          config.searchMaxQueries,
          config.searchTimeoutMs,
          Boolean(config.fetch && !ctx.yuExtensions.active.reader),
        );
      else
        applyWebFetchTool(
          proxy,
          config.fetchTimeoutMs,
          config.fetchMaxOutputChars,
        );
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
