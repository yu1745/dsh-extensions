import { credentialKey, credentialRef } from "@deepseek-ai/dsh-credentials";
import { createModels } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
const oauthClients = new WeakMap<object, any>();
export function codexModels(ctx: any) {
  let m = oauthClients.get(ctx.credentials);
  if (m) return m;
  const key = credentialKey("llm-pi-ai", "openai-codex");
  const store: any = {
    read: async () => {
      const r = await ctx.credentials.readRecord(key);
      return r?.kind === "grant" ? r.payload : undefined;
    },
    list: async () => [],
    delete: async () => {},
    modify: async (_id: string, fn: Function) => {
      let value: any;
      await ctx.credentials.modifyRecord(key, async (r: any) => {
        value = await fn(r?.kind === "grant" ? r.payload : undefined);
        return value ? { kind: "grant", payload: value } : r;
      });
      return value;
    },
  };
  m = createModels({ credentials: store });
  m.setProvider(openaiCodexProvider());
  oauthClients.set(ctx.credentials, m);
  return m;
}
const refs: Record<string, string[]> = {
  deepseek: ["DEEPSEEK_API_KEY"],
  "zai-coding-cn": ["ZAI_CODING_CN_API_KEY", "ZAI_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  typesafe: ["TYPESAFE_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
};
export async function providerAuth(ctx: any, provider: string) {
  if (provider === "openai-codex") return codexModels(ctx).getAuth(provider);
  const owner = ctx.get("yuProviders");
  if (["codebuddy", "antigravity"].includes(provider) && owner)
    return owner.getAuth(provider);
  // DSH's owning adapter resolves and refreshes OAuth under its credential lock.
  const adapter = ctx.get("yuPiAuth");
  if (adapter) {
    const result = await adapter(provider);
    if (result?.auth?.apiKey) return result;
  }
  const record = await ctx.credentials.readRecord(
    credentialKey("llm-pi-ai", provider),
  );
  if (record?.kind === "api-key" && record.key)
    return { auth: { apiKey: record.key } };
  if (record?.kind === "grant") {
    const c: any = record.payload;
    if (c.expires && c.expires <= Date.now())
      throw new Error(
        `${provider}: OAuth token expired; refresh through its DSH owner`,
      );
    if (provider === "antigravity")
      return {
        auth: {
          apiKey: JSON.stringify({ token: c.access, projectId: c.projectId }),
        },
      };
    return { auth: { apiKey: c.access }, credential: c };
  }
  for (const ref of refs[provider] ?? []) {
    const v = await ctx.credentials.resolve(credentialRef(ref));
    if (v?.value) return { auth: { apiKey: v.value } };
  }
  return undefined;
}
