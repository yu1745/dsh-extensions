import { credentialKey } from "@deepseek-ai/dsh-credentials";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import * as https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { codexAuthRemoteInfo } from "./codex-auth-remote.js";

/**
 * Self-contained openai-codex login.
 *
 * Policy (deliberate):
 * - The plugin never reads credentials from anywhere on disk (no ~/.codex,
 *   no ~/.pi, no environment). Tokens exist only inside the DSH credential
 *   record `llm-pi-ai/openai-codex`, written by this device-login flow.
 * - The record is the same grant shape pi-ai expects, so the pi-ai layer
 *   resolves requests and rotates expired access tokens through its store
 *   (wired in auth.ts) — refresh stays self-managed end to end.
 * - Tokens never leave the host service; the settings UI only ever sees
 *   account id, expiry, user code and error text.
 */

// Public Codex client, identical to the one pi-ai's own flow uses.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE = "https://auth.openai.com";
const DEVICE_USER_CODE_URL = `${AUTH_BASE}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE}/api/accounts/deviceauth/token`;
const TOKEN_URL = `${AUTH_BASE}/oauth/token`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE}/deviceauth/callback`;
const DEVICE_CODE_TIMEOUT_MS = 15 * 60 * 1000;
const MIN_POLL_MS = 5000;

const KEY = credentialKey("llm-pi-ai", "openai-codex");

function agent(): any {
  const proxy =
    process.env.https_proxy ||
    process.env.http_proxy ||
    process.env.ALL_PROXY;
  return proxy ? new HttpsProxyAgent(proxy) : undefined;
}

function postJson(url: string, body: any, signal?: AbortSignal, form = false) {
  return new Promise<{ status: number; json: any; text: string }>(
    (resolve, reject) => {
      signal?.throwIfAborted();
      const payload = form
        ? new URLSearchParams(body).toString()
        : JSON.stringify(body);
      const req = https.request(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": form
              ? "application/x-www-form-urlencoded"
              : "application/json",
            Accept: "application/json",
          },
          agent: agent(),
          signal,
        },
        (response) => {
          let raw = "";
          response.on("data", (chunk) => (raw += chunk));
          response.on("end", () => {
            let json: any = null;
            try {
              json = JSON.parse(raw);
            } catch {}
            resolve({ status: response.statusCode ?? 0, json, text: raw });
          });
        },
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    },
  );
}

function jwtPayload(token: string): any | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function accountIdOf(accessToken: string): string | undefined {
  const id = jwtPayload(accessToken)?.["https://api.openai.com/auth"]
    ?.chatgpt_account_id;
  return typeof id === "string" && id ? id : undefined;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Login cancelled"));
      },
      { once: true },
    );
  });

type Pending = {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  expiresAt: number;
  controller: AbortController;
};

export class CodexDeviceAuth extends TypertRemoteService {
  private pending: Pending | null = null;
  private pendingError = "";

  constructor(ctx: any) {
    super(ctx, "yuCodexAuth");
    ctx.effect(() =>
      ctx.typert.register({
        package: codexAuthRemoteInfo.package,
        face: "host",
        schemas: [],
        invocations: codexAuthRemoteInfo.descriptors,
        model: { services: [], events: [], objects: [] },
      }),
    );
    ctx.on("dispose", () => this.cancel());
  }

  private async recordPayload(): Promise<any | undefined> {
    const record = await this.ctx.credentials.readRecord(KEY);
    return record?.kind === "grant" ? record.payload : undefined;
  }

  private async view() {
    const credential = await this.recordPayload().catch(() => undefined);
    const base: any = {
      state: credential ? "logged-in" : "anonymous",
      accountId: credential?.accountId,
      expires: credential?.expires,
    };
    if (this.pending) {
      base.state = "pending";
      base.userCode = this.pending.userCode;
      base.verificationUri = DEVICE_VERIFICATION_URI;
      base.expiresAt = this.pending.expiresAt;
    }
    if (this.pendingError) base.error = this.pendingError;
    return base;
  }

  status() {
    return this.view();
  }

  /** Start (or report) a device login. Never returns tokens. */
  async login() {
    if (this.pending) {
      if (Date.now() >= this.pending.expiresAt) this.cancel();
      else return this.view();
    }
    this.pendingError = "";
    const signal = new AbortController();
    const response = await postJson(
      DEVICE_USER_CODE_URL,
      { client_id: CLIENT_ID },
      signal.signal,
    );
    if (!(response.status >= 200 && response.status < 300))
      throw new Error(
        `Device login unavailable (${response.status}): ${response.text.slice(0, 200)}`,
      );
    const { device_auth_id, user_code, interval } = response.json ?? {};
    const intervalSeconds = Number(interval);
    if (
      typeof device_auth_id !== "string" ||
      typeof user_code !== "string" ||
      !Number.isFinite(intervalSeconds)
    )
      throw new Error("Invalid device code response");
    this.pending = {
      deviceAuthId: device_auth_id,
      userCode: user_code,
      intervalMs: Math.max(MIN_POLL_MS, intervalSeconds * 1000),
      expiresAt: Date.now() + DEVICE_CODE_TIMEOUT_MS,
      controller: signal,
    };
    void this.poll(signal.signal);
    return this.view();
  }

  private async poll(signal: AbortSignal) {
    const pending = this.pending!;
    try {
      while (!signal.aborted && this.pending === pending) {
        await sleep(pending.intervalMs, signal);
        if (signal.aborted || this.pending !== pending) return;
        if (Date.now() >= pending.expiresAt) {
          this.pendingError = "Device code expired";
          this.pending = null;
          return;
        }
        const poll = await postJson(
          DEVICE_TOKEN_URL,
          { device_auth_id: pending.deviceAuthId, user_code: pending.userCode },
          signal,
        );
        if (poll.status === 403 || poll.status === 404) continue;
        const error = poll.json?.error;
        const code = typeof error === "object" ? error?.code : error;
        if (code === "deviceauth_authorization_pending") continue;
        if (code === "slow_down") {
          pending.intervalMs += 5000;
          continue;
        }
        if (!(poll.status >= 200 && poll.status < 300) ||
            !poll.json?.authorization_code || !poll.json?.code_verifier) {
          this.pendingError = `Device login failed (${poll.status}): ${(poll.text || "").slice(0, 200)}`;
          this.pending = null;
          return;
        }
        // Exchange the authorization code for tokens.
        const exchange = await postJson(
          TOKEN_URL,
          {
            grant_type: "authorization_code",
            client_id: CLIENT_ID,
            code: poll.json.authorization_code,
            code_verifier: poll.json.code_verifier,
            redirect_uri: DEVICE_REDIRECT_URI,
          },
          signal,
          true,
        );
        const accountId =
          exchange.json?.access_token &&
          accountIdOf(exchange.json.access_token);
        if (
          !(exchange.status >= 200 && exchange.status < 300) ||
          !exchange.json?.access_token ||
          !exchange.json?.refresh_token ||
          !accountId
        ) {
          this.pendingError = `Codex token exchange failed (${exchange.status}): ${(exchange.text || "").slice(0, 200)}`;
          this.pending = null;
          return;
        }
        await this.ctx.credentials.modifyRecord(KEY, async () => ({
          kind: "grant",
          payload: {
            type: "oauth",
            access: exchange.json.access_token,
            refresh: exchange.json.refresh_token,
            accountId,
            expires:
              Date.now() + (Number(exchange.json.expires_in) || 3600) * 1000,
          },
        }));
        this.pending = null;
        this.pendingError = "";
        return;
      }
    } catch (error) {
      if (signal.aborted || this.pending !== pending) return;
      this.pendingError =
        error instanceof Error ? error.message : String(error);
      this.pending = null;
    }
  }

  cancel() {
    const pending = this.pending;
    this.pending = null;
    this.pendingError = pending ? "Login cancelled" : "";
    pending?.controller.abort();
    return this.view();
  }

  async logout() {
    this.cancel();
    this.pendingError = "";
    await this.ctx.credentials.deleteRecord(KEY);
    return this.view();
  }
}

/** Host-side service: construct in a plugin scope that injects typert + credentials. */
export function installCodexDeviceAuth(ctx: any) {
  new CodexDeviceAuth(ctx);
}
