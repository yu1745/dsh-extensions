import z from "@deepseek-ai/schemastery";
import register from "./vendor/web-reader/index.js";
import { createBridge } from "./bridge.js";
export const name = "yu-web-reader";
export const inject = ["tools", "systemPrompt", "credentials", "yuExtensions"];
export const Config = z.object({
  classifier: z
    .object({
      provider: z.string(),
      model: z.string(),
    })
    .default({}),
});
export function apply(ctx: any, config: any) {
  const bridge = createBridge(ctx, { ...config, kind: "reader" });
  register(bridge as any);
  ctx.on("dispose", () => bridge.dispose());
}
