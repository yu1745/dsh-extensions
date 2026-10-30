import { z } from "zod";
import { createTypertRemoteInfo } from "@deepseek-ai/dsh-typert-protocol";
// This module is used by the browser too: no host code may be imported here.
function param(name: string, schema: () => any) {
  const codec = {
    mode: "strict" as const,
    typeSymbol: `@yu1745/dsh-extensions#CodexAuth-${name}`,
    create: schema,
  };
  return { name, source: "json" as const, codec, strictCodec: codec };
}
// Results are plain JSON; tokens never cross this boundary.
const result = {
  mode: "strict" as const,
  typeSymbol: "@yu1745/dsh-extensions#CodexAuthResult",
  create: () => z.json(),
};
export const codexAuthRemoteInfo = createTypertRemoteInfo({
  package: "@yu1745/dsh-extensions/codex-auth",
  methods: {
    "yuCodexAuth/status": {
      service: "yuCodexAuth",
      invocation: { kind: "direct" },
      parameters: [],
      result,
    },
    "yuCodexAuth/login": {
      service: "yuCodexAuth",
      invocation: { kind: "direct" },
      parameters: [],
      result,
    },
    "yuCodexAuth/cancel": {
      service: "yuCodexAuth",
      invocation: { kind: "direct" },
      parameters: [],
      result,
    },
    "yuCodexAuth/logout": {
      service: "yuCodexAuth",
      invocation: { kind: "direct" },
      parameters: [],
      result,
    },
  },
} as any);
