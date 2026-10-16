import { createProvider } from "@earendil-works/pi-ai";
import {
  loginAntigravity,
  refreshAntigravityToken,
  getApiKey,
} from "./vendor/antigravity/auth/oauth.js";
import { ANTIGRAVITY_MODELS } from "./vendor/antigravity/models/models.js";
import { DEFAULT_ENDPOINT } from "./vendor/antigravity/client/client.js";
import {
  ANTIGRAVITY_API,
  streamAntigravity,
} from "./vendor/antigravity/stream/stream.js";
export function createAntigravityProvider() {
  return createProvider({
    id: "antigravity",
    name: "Antigravity",
    baseUrl: DEFAULT_ENDPOINT,
    models: ANTIGRAVITY_MODELS.map((model) => ({
      ...model,
      provider: "antigravity",
      api: ANTIGRAVITY_API,
      baseUrl: DEFAULT_ENDPOINT,
    })) as any,
    auth: {
      oauth: {
        name: "Antigravity",
        async login(interaction: any) {
          const c = await loginAntigravity({
            signal: interaction.signal,
            onAuth: (notice: any) =>
              interaction.notify({ type: "auth_url", ...notice }),
            onPrompt: (prompt: any) =>
              interaction.prompt({ type: "manual_code", ...prompt }),
            onProgress: (message: string) =>
              interaction.notify({ type: "progress", message }),
          } as any);
          return { ...c, type: "oauth" as const };
        },
        async refresh(c: any, signal?: AbortSignal) {
          return {
            ...(await refreshAntigravityToken(c, signal)),
            type: "oauth" as const,
          };
        },
        async toAuth(c: any) {
          return { apiKey: getApiKey(c) };
        },
      },
    },
    api: {
      stream: streamAntigravity as any,
      streamSimple: streamAntigravity as any,
    },
  });
}
