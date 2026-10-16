import { z } from "zod";
import { createTypertRemoteInfo } from "@deepseek-ai/dsh-typert-protocol";
function param(name: string, schema: () => any) {
  const codec = {
    mode: "strict" as const,
    typeSymbol: `@yu1745/dsh-extensions#${name}`,
    create: schema,
  };
  return { name, source: "json" as const, codec, strictCodec: codec };
}
const result = {
  mode: "strict" as const,
  typeSymbol: "@yu1745/dsh-extensions#ProviderResult",
  create: () => z.json(),
};
export const providerRemoteInfo = createTypertRemoteInfo({
  package: "@yu1745/dsh-extensions/providers",
  methods: {
    "yuProviders/status": {
      service: "yuProviders",
      invocation: { kind: "direct" },
      parameters: [],
      result,
    },
    "yuProviders/loginStart": {
      service: "yuProviders",
      invocation: { kind: "direct" },
      parameters: [
        param("provider", () => z.enum(["codebuddy", "antigravity"])),
      ],
      result,
    },
    "yuProviders/loginAnswer": {
      service: "yuProviders",
      invocation: { kind: "direct" },
      parameters: [
        param("answer", () =>
          z
            .object({
              id: z.string().uuid(),
              promptId: z.string().uuid(),
              value: z.string().max(8192),
            })
            .strict(),
        ),
      ],
      result,
    },
    "yuProviders/loginCancel": {
      service: "yuProviders",
      invocation: { kind: "direct" },
      parameters: [param("id", () => z.string().uuid())],
      result,
    },
  },
});
