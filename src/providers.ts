import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import {
  resolveImageAttachmentAccess,
  resolveRetryPolicy,
} from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import {
  createCodebuddyProvider,
  refreshCodebuddy,
} from "./codebuddy-provider.js";
import { createAntigravityProvider } from "./antigravity-provider.js";
import { refreshAntigravityToken } from "./vendor/antigravity/auth/oauth.js";
import { providerRemoteInfo } from "./provider-remote.js";
export const name = "yu-providers";
export const inject = ["llm", "credentials", "authorization", "typert"];
const ids = ["codebuddy", "antigravity"] as const;
const keyFor = (id: string) => credentialKey("llm-pi-ai", id);
function checkId(id: string) {
  if (!(ids as readonly string[]).includes(id))
    throw new Error("Unknown provider");
}
export function credentialStore(ctx: any) {
  return {
    async read(id: string) {
      checkId(id);
      const r = await ctx.credentials.readRecord(keyFor(id));
      return r?.kind === "grant" ? r.payload : undefined;
    },
    async list() {
      const entries = await Promise.all(
        ids.map(async (id) =>
          (await ctx.credentials.readRecord(keyFor(id)))?.kind === "grant"
            ? { providerId: id, type: "oauth" as const }
            : null,
        ),
      );
      return entries.filter(Boolean) as any;
    },
    async modify(id: string, mutate: any) {
      checkId(id);
      const next = await ctx.credentials.modifyRecord(
        keyFor(id),
        async (record: any) => {
          const c = await mutate(
            record?.kind === "grant" ? record.payload : undefined,
          );
          return c === undefined ? undefined : { kind: "grant", payload: c };
        },
      );
      return next?.kind === "grant" ? next.payload : undefined;
    },
    async delete(id: string) {
      checkId(id);
      await ctx.credentials.deleteRecord(keyFor(id));
    },
  };
}
export function profileFor(provider: any) {
  return {
    provider: provider.id,
    displayName: provider.name,
    piProvider: provider,
    reasoning: "high",
    streamIdleTimeoutMs: 300000,
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024,
    modelErrors: new Map(),
    configuredMaxTokens: new Map(),
    retryPolicy: resolveRetryPolicy(),
  };
}
type Attempt = {
  id: string;
  provider: string;
  status: string;
  notices: any[];
  prompt?: any;
  error?: string;
  controller: AbortController;
  resolve?: (v: string) => void;
  reject?: (e: Error) => void;
  removePromptAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  task?: Promise<void>;
};
export class Providers extends TypertRemoteService {
  ready: Promise<void> = Promise.resolve();
  store: ReturnType<typeof credentialStore>;
  providers = new Map<string, any>();
  profiles = new Map<string, any>();
  models: any;
  registration: any;
  attempts = new Map<string, Attempt>();
  constructor(ctx: any) {
    super(ctx, "yuProviders");
    this.store = credentialStore(ctx);
    ctx.effect(() =>
      ctx.typert.register({
        package: providerRemoteInfo.package,
        face: "host",
        schemas: [],
        invocations: providerRemoteInfo.descriptors,
        model: { services: [], events: [], objects: [] },
      }),
    );
    ctx.on("dispose", async () => {
      for (const a of this.attempts.values()) this.cancelAttempt(a);
      await Promise.allSettled([...this.attempts.values()].map((a) => a.task));
      this.attempts.clear();
    });
  }
  async init() {
    await this.rebuild();
    const adapter = new PiAiAdapter({
      profiles: () => this.profiles,
      resolveApiKey: async () => undefined,
      auth: {
        credentials: this.store,
        authContext: {
          env: async () => undefined,
          fileExists: async () => false,
          readFile: async () => undefined,
        } as any,
      },
      resolveAttachments: () => this.ctx.get("attachments"),
      resolveImageAccess: (attachments: any, ref: any) =>
        resolveImageAttachmentAccess(
          attachments,
          (hostPath: string) =>
            this.ctx.get("fs")?.processPathFromHostPath(hostPath),
          ref,
        ),
    });
    this.registration = this.ctx.llm.registerAdapter(ids, adapter);
    for (const id of ids) {
      this.ctx.authorization.registerFlow({
        key: keyFor(id),
        label: this.providers.get(id).name,
        methods: [{ id: "oauth", label: "浏览器登录 / 导入" }],
        run: async (session: any) => {
          const oauth = this.providers.get(id).auth.oauth;
          const credential = await oauth.login({
            signal: session.signal,
            notify: (n: any) =>
              session.notify({
                message: n.instructions ?? n.message ?? "请在浏览器中继续登录",
                ...(n.url ? { url: n.url } : {}),
              }),
            prompt: (p: any) =>
              session.prompt({
                ...p,
                kind:
                  p.type === "select"
                    ? "select"
                    : p.type === "secret"
                      ? "secret"
                      : "text",
              }),
          });
          await session.commit({
            kind: "grant",
            payload: { ...credential, type: "oauth" },
          });
          await this.rebuild();
          this.registration?.replace(ids);
        },
      });
    }
  }
  async rebuild() {
    const codebuddy = await createCodebuddyProvider({
      readCredential: (id) => this.store.read(id),
      refreshCredential: (id, token, signal) =>
        this.refreshCredential(id, token, signal),
    });
    const antigravity = createAntigravityProvider();
    this.providers = new Map([
      ["codebuddy", codebuddy],
      ["antigravity", antigravity],
    ]);
    this.profiles = new Map(
      [...this.providers].map(([id, p]) => [id, profileFor(p)]),
    );
    this.models = createModels({ credentials: this.store });
    for (const p of this.providers.values()) this.models.setProvider(p);
  }
  async refreshCredential(
    id: string,
    observedAccess?: string,
    signal?: AbortSignal,
  ) {
    checkId(id);
    return this.store.modify(id, async (current: any) => {
      if (!current?.refresh)
        throw new Error(`${id} 未登录，请在服务登录中授权`);
      if (
        observedAccess &&
        current.access !== observedAccess &&
        current.expires > Date.now()
      )
        return current;
      const next =
        id === "codebuddy"
          ? await refreshCodebuddy(current, signal)
          : await refreshAntigravityToken(current, signal);
      return { ...next, type: "oauth" };
    });
  }
  async getAuth(id: string) {
    checkId(id);
    await this.ready;
    return this.models.getAuth(id);
  }
  async status() {
    await this.ready;
    return {
      providers: await Promise.all(
        ids.map(async (id) => {
          const c: any = await this.store.read(id);
          return {
            id,
            name: this.providers.get(id)?.name ?? id,
            connected: Boolean(c?.access),
            expires: c?.expires ?? null,
            account: c?.email || c?.nickname || null,
            models: this.models?.getModels(id).length ?? 0,
          };
        }),
      ),
      attempts: [...this.attempts.values()].map(
        ({ id, provider, status, notices, prompt, error }) => ({
          id,
          provider,
          status,
          notices,
          ...(prompt ? { prompt } : {}),
          ...(error ? { error } : {}),
        }),
      ),
    };
  }
  cancelAttempt(a: Attempt) {
    clearTimeout(a.timer);
    a.controller.abort();
    a.removePromptAbort?.();
    a.reject?.(new Error("登录已取消"));
  }
  async loginStart(provider: string) {
    checkId(provider);
    await this.ready;
    for (const a of this.attempts.values())
      if (a.provider === provider && a.status === "pending")
        return { id: a.id };
    for (const [id, a] of this.attempts)
      if (a.provider === provider) this.attempts.delete(id);
    const a: Attempt = {
      id: randomUUID(),
      provider,
      status: "pending",
      notices: [],
      controller: new AbortController(),
    };
    this.attempts.set(a.id, a);
    a.timer = setTimeout(() => this.cancelAttempt(a), 310000);
    a.timer.unref();
    a.task = this.ctx.authorization
      .begin({
        key: keyFor(provider),
        signal: a.controller.signal,
        interaction: {
          notify: (n: any) => {
            a.notices.push(n);
            if (a.notices.length > 8) a.notices.shift();
          },
          prompt: (p: any) =>
            new Promise<string>((resolve, reject) => {
              const promptId = randomUUID();
              a.prompt = {
                id: promptId,
                kind: p.kind,
                message: p.message,
                ...(p.options ? { options: p.options } : {}),
                ...(p.placeholder ? { placeholder: p.placeholder } : {}),
              };
              a.resolve = resolve;
              a.reject = reject;
              const abort = () => {
                if (a.prompt?.id === promptId) {
                  a.prompt = undefined;
                  a.resolve = undefined;
                  a.reject = undefined;
                }
                reject(new Error("登录问题已取消"));
              };
              p.signal?.addEventListener("abort", abort, { once: true });
              a.removePromptAbort = () =>
                p.signal?.removeEventListener("abort", abort);
              if (p.signal?.aborted) abort();
            }),
        },
      })
      .then(
        (outcome: any) => {
          a.status =
            outcome === "cancelled" || outcome?.status === "cancelled"
              ? "cancelled"
              : "authorized";
        },
        (e: any) => {
          a.status = a.controller.signal.aborted ? "cancelled" : "failed";
          a.error =
            a.status === "failed" ? String(e.message).slice(0, 500) : undefined;
        },
      )
      .finally(() => {
        clearTimeout(a.timer);
        a.removePromptAbort?.();
        a.prompt = undefined;
        a.resolve = undefined;
        a.reject = undefined;
      });
    return { id: a.id };
  }
  async loginAnswer(answer: { id: string; promptId: string; value: string }) {
    const a = this.attempts.get(answer.id);
    if (
      !a ||
      a.status !== "pending" ||
      a.prompt?.id !== answer.promptId ||
      !a.resolve
    )
      throw new Error("登录问题已过期，请重新查看状态");
    if (
      a.prompt.kind === "select" &&
      !a.prompt.options?.some((o: any) => o.id === answer.value)
    )
      throw new Error("无效选项");
    const resolve = a.resolve;
    a.removePromptAbort?.();
    a.prompt = undefined;
    a.resolve = undefined;
    a.reject = undefined;
    resolve(answer.value);
    return { ok: true };
  }
  async loginCancel(id: string) {
    const a = this.attempts.get(id);
    if (a) this.cancelAttempt(a);
    return { ok: true };
  }
}
export async function apply(ctx: any) {
  const service = new Providers(ctx);
  service.ready = service.init();
  await service.ready;
}
