import { z } from "zod";
import { createTypertRemoteInfo } from "@deepseek-ai/dsh-typert-protocol";
import { fallbackConfigSchema } from "./fallback-schema.js";
// This module is used by the browser too: no host code may be imported here.
function param(name: string, create: () => any) {
  const codec = {
    mode: "strict",
    typeSymbol: `@yu1745/dsh-extensions#Fallback-${name}`,
    create,
  };
  return { name, source: "json", codec, strictCodec: codec };
}
const result = {
  mode: "strict",
  typeSymbol: "@yu1745/dsh-extensions#FallbackResult",
  create: () => z.json(),
};
export const fallbackRemoteInfo = createTypertRemoteInfo({
  package: "@yu1745/dsh-extensions/model-fallback",
  methods: {
    "yuModelFallback/status": {
      service: "yuModelFallback",
      invocation: { kind: "direct" },
      parameters: [],
      result,
    },
    "yuModelFallback/catalog": {
      service: "yuModelFallback",
      invocation: { kind: "direct" },
      parameters: [],
      result,
    },
    "yuModelFallback/save": {
      service: "yuModelFallback",
      invocation: { kind: "direct" },
      parameters: [param("value", () => fallbackConfigSchema)],
      result,
    },
    "yuModelFallback/retry": {
      service: "yuModelFallback",
      invocation: { kind: "direct" },
      parameters: [
        param("route", () =>
          z
            .object({
              provider: z.string().min(1).max(200),
              model: z.string().min(1).max(200),
            })
            .strict(),
        ),
      ],
      result,
    },
  },
} as any);
