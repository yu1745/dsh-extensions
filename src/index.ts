import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { credentialRef, credentialKey } from "@deepseek-ai/dsh-credentials";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readJson,
  settings,
  updateSettings,
  writeJson,
  dataDir,
} from "./state.js";
export const name = "yu-extensions";
export const inject = ["credentials"];
export const Config = z.object({ importPi: z.boolean().default(false) });
export class Extensions extends Service {
  active = { search: false, reader: false };
  definitions = new Map<string, { tool: any; guidance: string }>();
  install(kind: string, tool: any, guidance: string) {
    const record = { tool, guidance };
    this.definitions.set(kind, record);
    this.ctx.emit("yu-extensions/web-features");
    return () => {
      if (this.definitions.get(kind) === record) {
        this.definitions.delete(kind);
        this.ctx.emit("yu-extensions/web-features");
      }
    };
  }
  constructor(ctx: any) {
    super(ctx, "yuExtensions");
  }
  claim(kind: "search" | "reader") {
    if (this.active[kind]) throw new Error(`Duplicate ${kind} plugin`);
    this.active[kind] = true;
    this.ctx.emit("yu-extensions/web-features");
    return () => {
      if (this.active[kind]) {
        this.active[kind] = false;
        this.ctx.emit("yu-extensions/web-features");
      }
    };
  }
}
export async function importPi(ctx: any) {
  const marker = join(dataDir, "imported-pi.json");
  if (readJson(marker, null)) return;
  const pi = join(homedir(), ".pi/agent");
  const auth: any = readJson(join(pi, "auth.json"), {});
  const imported: string[] = [];
  const refs: any = {
    deepseek: "DEEPSEEK_API_KEY",
    "zai-coding-cn": "ZAI_CODING_CN_API_KEY",
    "minimax-cn": "MINIMAX_CN_API_KEY",
    typesafe: "TYPESAFE_API_KEY",
    "typesafe-jev": "TYPESAFE_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
  };
  for (const [id, ref] of Object.entries(refs) as any) {
    const credential = auth[id];
    const key =
      credential?.type === "api_key"
        ? credential.key
        : id === "openrouter"
          ? credential?.access
          : undefined;
    if (
      typeof key === "string" &&
      key &&
      !key.startsWith("!") &&
      !(await ctx.credentials.resolve(credentialRef(ref)))
    ) {
      await ctx.credentials.set(credentialRef(ref), key);
      imported.push(id);
    }
  }
  const codex = auth["openai-codex"];
  if (codex?.type === "oauth")
    await ctx.credentials.modifyRecord(
      credentialKey("llm-pi-ai", "openai-codex"),
      async (current: any) => current ?? { kind: "grant", payload: codex },
    );
  const old: any = readJson(join(pi, "settings.json"), {});
  const current = settings();
  updateSettings({
    ...(current.webSearchBackend
      ? {}
      : {
          webSearchBackend:
            old.webSearchBackend ??
            (old.antigravityGoogleSearch === false ? "zai" : "google"),
        }),
    ...(current.classifier
      ? {}
      : { classifier: { provider: "typesafe", model: "jev-latest" } }),
  });
  const tracker = readJson<any>(join(pi, "codex-cost-tracker.json"), null);
  if (tracker && !readJson(join(dataDir, "codex-cost-tracker.json"), null))
    writeJson(join(dataDir, "codex-cost-tracker.json"), tracker);
  writeJson(marker, {
    importedAt: Date.now(),
    providers: imported,
    piCredentialsRetained: true,
  });
}
export async function apply(ctx: any, config: any) {
  if (config.importPi) await importPi(ctx);
  new Extensions(ctx);
}
