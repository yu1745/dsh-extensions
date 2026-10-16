import { createProvider } from "@earendil-works/pi-ai";
import {
  stream as streamOpenAICompletions,
  streamSimple as streamSimpleOpenAICompletions,
} from "@earendil-works/pi-ai/api/openai-completions";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { providerFetch } from "./provider-http.js";
import { modelsFromConfig } from "./codebuddy-models.js";
import { dataDir, readJson, writeJson } from "./state.js";
const BASE = "https://copilot.tencent.com";
const common = {
  "User-Agent": "CLI/2.151.0 CodeBuddy/2.151.0",
  "X-Requested-With": "XMLHttpRequest",
  "X-Product": "SaaS",
  "X-Domain": "www.codebuddy.cn",
};
export type ProviderRuntime = {
  fetch?: typeof providerFetch;
  readCredential: (id: string) => Promise<any>;
  refreshCredential: (
    id: string,
    observedAccess?: string,
    signal?: AbortSignal,
  ) => Promise<any>;
};
function accountHeaders(c: any) {
  return {
    ...common,
    Authorization: `Bearer ${c.access}`,
    "X-User-Id": c.userId ?? "",
    "X-Domain": c.domain ?? "www.codebuddy.cn",
  };
}
async function json(path: string, init: any = {}) {
  const r = await providerFetch(
    BASE + path,
    { ...init, headers: { ...common, ...init.headers } },
    20000,
  );
  if (!r.ok) throw new Error(`CodeBuddy account API: HTTP ${r.status}`);
  const body: any = await r.json();
  if (body.code !== undefined && ![0, 200, "0", "200"].includes(body.code))
    throw new Error(
      `CodeBuddy account API rejected request (${String(body.code)})`,
    );
  return body.data ?? body;
}
export async function refreshCodebuddy(c: any, signal?: AbortSignal) {
  const d = await json("/v2/plugin/auth/token/refresh", {
    method: "POST",
    signal,
    headers: {
      ...accountHeaders(c),
      "X-Refresh-Token": c.refresh,
      "X-Auth-Refresh-Source": "plugin",
      "Content-Type": "application/json",
      "X-Request-ID": randomUUID().replaceAll("-", ""),
    },
    body: "{}",
  });
  if (!d.accessToken)
    throw new Error("CodeBuddy refresh did not return an access token");
  return {
    ...c,
    type: "oauth",
    access: d.accessToken,
    refresh: d.refreshToken || c.refresh,
    expires: Date.now() + (Number(d.expiresIn) || 3600) * 1000 - 120000,
  };
}
async function importOfficialCredential() {
  const dir = join(
    homedir(),
    ".local/share/CodeBuddyExtension/Data/Public/auth",
  );
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".info"));
  } catch {
    files = [];
  }
  for (const file of files) {
    try {
      const d = JSON.parse(await readFile(join(dir, file), "utf8"));
      if (!d?.auth?.accessToken || !d?.auth?.refreshToken) continue;
      return {
        type: "oauth",
        access: d.auth.accessToken,
        refresh: d.auth.refreshToken,
        expires: Number(d.auth.expiresAt) || 0,
        userId: String(d.account?.uid ?? ""),
        domain: d.auth.domain || "www.codebuddy.cn",
        nickname: d.account?.nickname ?? "",
      };
    } catch {}
  }
  throw new Error("未找到官方 CodeBuddy CLI 凭据，请使用浏览器登录。");
}
async function loginCodebuddy(interaction: any) {
  const signal = interaction.signal;
  const method = await interaction.prompt({
    type: "select",
    message: "CodeBuddy 登录方式",
    options: [
      { id: "oauth", label: "浏览器登录" },
      { id: "import", label: "导入本机官方 CLI 凭据" },
    ],
  });
  if (method === "import") return importOfficialCredential();
  const state = await json("/v2/plugin/auth/state?platform=CLI", {
    method: "POST",
    body: "{}",
    headers: { "Content-Type": "application/json" },
    signal,
  });
  if (!state.state || !state.authUrl)
    throw new Error("CodeBuddy 未返回登录地址");
  interaction.notify({
    type: "auth_url",
    url: state.authUrl,
    instructions: "在浏览器中完成 CodeBuddy 登录后自动继续。",
  });
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    await delay(3000, undefined, { signal });
    let d: any;
    try {
      d = await json(
        `/v2/plugin/auth/token?state=${encodeURIComponent(state.state)}`,
        { signal },
      );
    } catch (e) {
      if (signal?.aborted) throw e;
      continue;
    }
    if (!d.accessToken || !d.refreshToken) continue;
    const c: any = {
      type: "oauth",
      access: d.accessToken,
      refresh: d.refreshToken,
      expires: Date.now() + (Number(d.expiresIn) || 3600) * 1000 - 120000,
      domain: d.domain || "www.codebuddy.cn",
    };
    const account = await json("/v2/plugin/login/account", {
      headers: accountHeaders(c),
      signal,
    });
    return {
      ...c,
      userId: String(account.uid ?? account.userId ?? ""),
      nickname: account.nickname ?? "",
      domain: account.domain || c.domain,
    };
  }
  throw new Error("CodeBuddy 登录超时，请重试。");
}
export async function createCodebuddyProvider(runtime: ProviderRuntime) {
  const cacheFile = join(dataDir, "codebuddy-models.json");
  let models = readJson<any[]>(cacheFile, []);
  try {
    let c = await runtime.readCredential("codebuddy");
    if (c) {
      if (!c.expires || c.expires <= Date.now())
        c = await runtime.refreshCredential("codebuddy", c.access);
      const d = await json("/v3/config", { headers: accountHeaders(c) });
      const next = modelsFromConfig({ data: d });
      if (next.length) {
        models = next;
        writeJson(cacheFile, models);
      }
    }
  } catch {
    /* Keep the last account catalog when discovery is offline. */
  }
  if (!models.length)
    models = modelsFromConfig({
      data: {
        models: [
          {
            id: "deepseek-v4.1-flash",
            name: "DeepSeek V4.1 Flash",
            supportsToolCall: true,
            supportsReasoning: true,
            supportsImages: true,
            maxInputTokens: 1000000,
            maxOutputTokens: 128000,
          },
        ],
      },
    });
  function options(o: any) {
    const sessionId = o?.sessionId ?? randomUUID();
    return {
      ...o,
      fetch: async (input: any, init: any = {}) => {
        const c = await runtime.readCredential("codebuddy");
        if (!c) throw new Error("CodeBuddy 未登录");
        const requestId = randomUUID().replaceAll("-", "");
        const send = (credential: any) => {
          const headers = new Headers(init.headers);
          for (const [key, value] of Object.entries({
            ...accountHeaders(credential),
            "x-codebuddy-request": "1",
            "X-IDE-Type": "CLI",
            "X-IDE-Name": "CLI",
            "X-IDE-Version": "2.151.0",
            "X-Conversation-ID": sessionId,
            "X-Request-ID": requestId,
            "X-Conversation-Message-ID": requestId,
          }))
            headers.set(key, value);
          return (runtime.fetch ?? providerFetch)(
            typeof input === "string" ? input : (input.url ?? input.toString()),
            { ...init, headers: Object.fromEntries(headers) },
          );
        };
        let response = await send(c);
        if (response.status === 401) {
          await response.body?.cancel();
          const refreshed = await runtime.refreshCredential(
            "codebuddy",
            c.access,
            init.signal,
          );
          response = await send(refreshed);
        }
        return response;
      },
    };
  }
  return createProvider({
    id: "codebuddy",
    name: "CodeBuddy",
    baseUrl: BASE + "/v2",
    models: models as any,
    auth: {
      oauth: {
        name: "CodeBuddy",
        login: loginCodebuddy,
        refresh: refreshCodebuddy,
        toAuth: async (c: any) => ({ apiKey: c.access }),
      },
    },
    api: {
      stream: (m: any, c: any, o: any) =>
        streamOpenAICompletions(m, c, options(o)),
      streamSimple: (m: any, c: any, o: any) =>
        streamSimpleOpenAICompletions(m, c, options(o)),
    },
  });
}
