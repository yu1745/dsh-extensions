/**
 * One-way codex token mirror: ~/.codex/auth.json -> DSH credential record
 * `llm-pi-ai/openai-codex`.
 *
 * Policy (deliberate):
 * - codex CLI is the single source of truth for the OAuth tokens; this module
 *   never writes to ~/.codex/auth.json and never refreshes or rotates tokens
 *   itself. Rotation is always performed by codex; we only mirror the result.
 * - Updates land via `ctx.credentials.modifyRecord`, which credentials-local
 *   persists to `.credentials.yaml`; its chokidar watcher hot-reloads the
 *   document, so no service restart is involved.
 * - Skips when codex is logged out or its access token is already expired
 *   (wait for codex to refresh rather than pushing stale data), and writes
 *   only when the payload actually differs.
 */
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import { watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJson } from "./state.js";

const CODEX_AUTH = join(homedir(), ".codex/auth.json");
const RECORD = credentialKey("llm-pi-ai", "openai-codex");
/** Backstop poll: fs.watch events can be missed (rename, editors, network fs). */
const BACKSTOP_MS = 5 * 60 * 1000;
/** Debounce: codex rewrites auth.json non-atomically during refresh. */
const DEBOUNCE_MS = 2000;

function jwtExp(token: string): number | undefined {
  try {
    const part = token.split(".")[1];
    const padded = part + "=".repeat((-part.length % 4 + 4) % 4);
    return JSON.parse(Buffer.from(padded, "base64url").toString("utf8")).exp;
  } catch {
    return undefined;
  }
}

export function codexTokenPayload(): any | undefined {
  const auth: any = readJson(CODEX_AUTH, null);
  const tokens = auth?.tokens;
  const access = tokens?.access_token;
  const refresh = tokens?.refresh_token;
  if (typeof access !== "string" || typeof refresh !== "string") return undefined;
  const exp = jwtExp(access);
  if (exp !== undefined && exp * 1000 <= Date.now()) return undefined; // wait for codex to refresh
  return {
    type: "oauth",
    access,
    refresh,
    accountId: typeof tokens.account_id === "string" ? tokens.account_id : undefined,
    ...(exp !== undefined ? { expires: Math.floor(exp * 1000) } : {}),
  };
}

export async function syncCodexToken(ctx: any): Promise<boolean> {
  let payload: any;
  try {
    payload = codexTokenPayload();
  } catch (error) {
    ctx.logger?.warn?.("codex-token-sync: cannot read codex auth: %o", error);
    return false;
  }
  if (!payload) return false; // logged out, or expired and waiting on codex
  try {
    let changed = false;
    await ctx.credentials.modifyRecord(RECORD, async (current: any) => {
      if (current?.kind !== "grant" || !current.payload) return current; // never create or retype the record
      const next: any = { ...current.payload };
      for (const [key, value] of Object.entries(payload))
        if (value !== undefined) next[key] = value;
      const same = Object.entries(next).every(
        ([key, value]) => current.payload[key] === value,
      );
      if (same) return current;
      changed = true;
      return { kind: "grant", payload: next };
    });
    if (changed)
      ctx.logger?.info?.("codex-token-sync: mirrored fresh codex tokens");
    return changed;
  } catch (error) {
    ctx.logger?.warn?.("codex-token-sync: mirror failed: %o", error);
    return false;
  }
}

/** Install the watcher + backstop poll. Disposed with the plugin context. */
export function startCodexTokenSync(ctx: any) {
  let timer: any;
  const run = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void syncCodexToken(ctx), DEBOUNCE_MS);
  };
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(CODEX_AUTH, run);
  } catch {
    // Missing file (codex logged out); the backstop picks it up on login.
  }
  const backstop = setInterval(() => void syncCodexToken(ctx), BACKSTOP_MS);
  ctx.on("dispose", () => {
    clearTimeout(timer);
    clearInterval(backstop);
    watcher?.close();
  });
  void syncCodexToken(ctx);
}
