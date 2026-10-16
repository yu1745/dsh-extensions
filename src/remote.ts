import { z } from "zod";
import { createTypertRemoteInfo } from "@deepseek-ai/dsh-typert-protocol";
export const remoteInfo = createTypertRemoteInfo({
  package: "@yu1745/dsh-extensions",
  methods: {
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
