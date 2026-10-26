import { z } from "zod";
import { createTypertRemoteInfo } from "@deepseek-ai/dsh-typert-protocol";
function speedParam(name: string, create: () => any) {
  const codec = {
    mode: "strict",
    typeSymbol: `@yu1745/dsh-extensions#Speed-${name}`,
    create,
  };
  return { name, source: "json", codec, strictCodec: codec };
}
const speedResult = {
  mode: "strict",
  typeSymbol: "@yu1745/dsh-extensions#SpeedResult",
  create: () => z.object({ mode: z.enum(["standard", "fast", "ultrafast"]) }),
};
export const remoteInfo = createTypertRemoteInfo({
  package: "@yu1745/dsh-extensions",
  methods: {
    "yuQuota/speed": {
      service: "yuQuota",
      invocation: { kind: "direct" },
      parameters: [
        speedParam("sessionId", () =>
          z
            .string()
            .regex(/^[a-zA-Z0-9_-]+$/)
            .max(200),
        ),
      ],
      result: speedResult,
    },
    "yuQuota/setFast": {
      service: "yuQuota",
      invocation: { kind: "direct" },
      parameters: [
        speedParam("sessionId", () =>
          z
            .string()
            .regex(/^[a-zA-Z0-9_-]+$/)
            .max(200),
        ),
        speedParam("enabled", () => z.boolean()),
      ],
      result: speedResult,
    },
    "yuQuota/snapshot": {
      service: "yuQuota",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "@yu1745/dsh-extensions#QuotaSnapshot",
        create: () => z.json(),
      },
    },
    "yuQuota/searchBackend": {
      service: "yuQuota",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "sessionId",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "@yu1745/dsh-extensions#SearchSessionId",
            create: () =>
              z
                .string()
                .regex(/^[a-zA-Z0-9_-]+$/)
                .max(200),
          },
          strictCodec: {
            mode: "strict",
            typeSymbol: "@yu1745/dsh-extensions#SearchSessionId",
            create: () =>
              z
                .string()
                .regex(/^[a-zA-Z0-9_-]+$/)
                .max(200),
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "@yu1745/dsh-extensions#SearchBackend",
        create: () =>
          z.object({
            backend: z.enum(["google", "openai", "deepseek", "minimax", "zai"]),
          }),
      },
    },
    "yuQuota/preferences": {
      service: "yuQuota",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "@yu1745/dsh-extensions#Preferences",
        create: () => z.json(),
      },
    },
    "yuQuota/savePreferences": {
      service: "yuQuota",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "value",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "@yu1745/dsh-extensions#PreferencesInput",
            create: () =>
              z
                .object({
                  webSearchBackend: z.enum([
                    "google",
                    "openai",
                    "deepseek",
                    "minimax",
                    "zai",
                  ]),
                  classifier: z.object({
                    provider: z.enum(["typesafe", "openai", "openrouter"]),
                    model: z.string().min(1).max(200),
                  }),
                })
                .strict(),
          },
          strictCodec: {
            mode: "strict",
            typeSymbol: "@yu1745/dsh-extensions#PreferencesInput",
            create: () =>
              z
                .object({
                  webSearchBackend: z.enum([
                    "google",
                    "openai",
                    "deepseek",
                    "minimax",
                    "zai",
                  ]),
                  classifier: z.object({
                    provider: z.enum(["typesafe", "openai", "openrouter"]),
                    model: z.string().min(1).max(200),
                  }),
                })
                .strict(),
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "@yu1745/dsh-extensions#PreferencesSaveResult",
        create: () => z.object({ restartRequired: z.boolean() }),
      },
    },
  },
} as any);
