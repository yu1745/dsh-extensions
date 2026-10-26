import { z } from "zod";
export const fallbackRouteSchema = z
  .object({
    provider: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
  })
  .strict();
export type Route = z.infer<typeof fallbackRouteSchema>;
export const fallbackConfigSchema = z
  .object({
    enabled: z.boolean(),
    models: z.array(fallbackRouteSchema).max(256),
  })
  .strict()
  .superRefine((config, ctx) => {
    const keys = config.models.map((r) =>
      JSON.stringify([r.provider, r.model]),
    );
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({ code: "custom", message: "模型不能重复" });
    if (config.enabled && !keys.length)
      ctx.addIssue({ code: "custom", message: "请先选择回退模型" });
  });
export type FallbackConfig = z.infer<typeof fallbackConfigSchema>;
