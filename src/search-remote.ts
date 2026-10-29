import { z } from "zod";
import { createTypertRemoteInfo } from "@deepseek-ai/dsh-typert-protocol";
// This module is used by the browser too: no host code may be imported here.
export const searchBackends = [
  "google",
  "openai",
  "deepseek",
  "minimax",
  "zai",
] as const;
const backend = () => z.enum(searchBackends);
const param = (name: string, create: () => any) => {
  const codec = {
    mode: "strict" as const,
    typeSymbol: `@yu1745/dsh-extensions#Search-${name}`,
    create,
  };
  return { name, source: "json" as const, codec, strictCodec: codec };
};
// One codec per shape: the Gateway compares codec identity by name and type.
const settingsResult = {
  mode: "strict" as const,
  typeSymbol: "@yu1745/dsh-extensions#SearchSettings",
  create: () =>
    z.object({
      defaultBackend: backend(),
      backends: z.array(backend()),
      overrides: z.array(
        z.object({ sessionId: z.string(), backend: backend() }),
      ),
    }),
};
export const searchRemoteInfo = createTypertRemoteInfo({
  package: "@yu1745/dsh-extensions/web-search",
  methods: {
    "yuWebSearch/settings": {
      service: "yuWebSearch",
      invocation: { kind: "direct" },
      parameters: [],
      result: settingsResult,
    },
    "yuWebSearch/setDefault": {
      service: "yuWebSearch",
      invocation: { kind: "direct" },
      parameters: [param("backend", backend)],
      result: settingsResult,
    },
    "yuWebSearch/clearOverrides": {
      service: "yuWebSearch",
      invocation: { kind: "direct" },
      parameters: [],
      result: settingsResult,
    },
  },
} as any);
