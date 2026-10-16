import z from "@deepseek-ai/schemastery";
import register from "./vendor/web-search/index.js";
import { configureBackend } from "./vendor/web-search/backend-config.js";
import { createBridge } from "./bridge.js";
export const name = "yu-web-search";
export const inject = ["tools", "systemPrompt", "credentials", "yuExtensions"];
export const Config = z.object({
  backend: z
    .union(["google", "openai", "deepseek", "minimax", "zai"])
    .default("google"),
});
export function apply(ctx: any, config: any) {
  configureBackend(config.backend);
  const bridge = createBridge(ctx, { kind: "search" });
  register(bridge as any);
  ctx.on("dispose", () => bridge.dispose());
}
