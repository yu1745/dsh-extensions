import { setSpeed, speedOf } from "./speed-context.js";
import { searchBackendFor } from "./search-context.js";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import lockfile from "proper-lockfile";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { remoteInfo } from "./remote.js";
import {
  dataDir,
  readJson,
  writeJson,
  settings,
  updateSettings,
} from "./state.js";
import { providerAuth } from "./auth.js";
import { fetchDS } from "./vendor/quota-footer/providers/deepseek.js";
import { fetchGLM } from "./vendor/quota-footer/providers/glm.js";
import { fetchMM } from "./vendor/quota-footer/providers/minimax.js";
import { fetchCodex } from "./vendor/quota-footer/providers/codex.js";
import { fetchAntigravity } from "./vendor/quota-footer/providers/antigravity.js";
import { shortHash } from "./vendor/quota-footer/utils.js";
import {
  requestCodexJson,
  getCodexAccountId,
} from "./vendor/shared/codex-api.js";
import {
  installCosts,
  costRows,
  aggregateCosts,
  readParents,
} from "./costs.js";

export const name = "yu-quota";
export const inject = ["credentials", "llm", "typert"];
const snapshotFile = join(dataDir, "quota.json");
const historyFile = join(dataDir, "quota-history.json");
const sources: Record<string, (key: string) => Promise<any>> = {
  deepseek: fetchDS,
  "zai-coding-cn": fetchGLM,
  "minimax-cn": fetchMM,
  "openai-codex": fetchCodex,
  antigravity: fetchAntigravity,
};

/** One process polls for the whole DSH home; a crashed owner expires after 30s. */
export async function acquirePoller(
  onCompromised: (error: Error) => void = () => {},
) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    return await lockfile.lock(dataDir, {
      realpath: false,
      lockfilePath: join(dataDir, "poller.lock"),
      retries: 0,
      stale: 30000,
      update: 10000,
      onCompromised,
    });
  } catch (error: any) {
    if (error.code === "ELOCKED") return undefined;
    throw error;
  }
}

export function historyKey(provider: string, key: string) {
  let id = shortHash(key);
  if (provider === "openai-codex") id = getCodexAccountId(key) ?? id;
  if (provider === "antigravity") {
    try {
      id = JSON.parse(key).projectId ?? id;
    } catch {}
  }
  return `${provider}:${id}`;
}

export function pointsFromPayload(payload: any) {
  if (payload.currency)
    return [{ name: "balance", value: payload.total, unit: payload.currency }];
  if (payload.buckets)
    return payload.buckets.map((b: any) => ({
      name: b.label,
      value: b.leftPercent,
      unit: "%",
      resetAt: b.resetTime,
    }));
  const windows = payload.interval
    ? { interval: payload.interval, weekly: payload.weekly }
    : payload.primary
      ? { primary: payload.primary, secondary: payload.secondary }
      : {
          quota: {
            leftPercent: payload.leftPercent,
            resetAt: payload.nextResetTime,
          },
          week: {
            leftPercent: payload.weekLeftPercent,
            resetAt: payload.weekNextResetTime,
          },
          mcp: { leftPercent: payload.mcpLeftPercent },
        };
  return Object.entries(windows)
    .filter(([, w]: any) => Number.isFinite(w?.leftPercent))
    .map(([name, w]: any) => ({
      name,
      value: w.leftPercent,
      unit: "%",
      resetAt: w.resetAt ?? w.endAt,
    }));
}

export function appendHistory(
  history: any,
  key: string,
  points: any[],
  now = Date.now(),
) {
  const previous = history[key] ?? [];
  const last = previous.at(-1);
  if (
    !last ||
    JSON.stringify(last.points) !== JSON.stringify(points) ||
    now - last.timestamp >= 4 * 3600000
  )
    previous.push({ timestamp: now, points });
  history[key] = previous
    .filter((p: any) => p.timestamp >= now - 30 * 86400000)
    .slice(-500);
  return history;
}

export async function codexLedger(ctx: any) {
  const auth = await providerAuth(ctx, "openai-codex");
  const token = auth?.auth?.apiKey;
  if (!token) throw new Error("未登录 Codex");
  const accountId = getCodexAccountId(token);
  if (!accountId) throw new Error("Codex 凭据缺少账号标识");
  const credentials = { accessToken: token, accountId };
  const quota: any = readJson(snapshotFile, {} as any).providers?.[
    "openai-codex"
  ]?.payload;
  const tracker: any = readJson(join(dataDir, "codex-cost-tracker.json"), {});
  const windows = [quota?.primary, quota?.secondary]
    .filter(Boolean)
    .sort((a: any, b: any) => (b.windowSeconds ?? 0) - (a.windowSeconds ?? 0));
  const window = windows[0];
  const start = window?.resetAt
    ? window.resetAt * 1000 - (window.windowSeconds ?? 604800) * 1000
    : Date.now() - 7 * 86400000;
  const startDate =
    tracker.customStartUtcDate ?? new Date(start).toISOString().slice(0, 10);
  const endDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const range = `start_date=${startDate}&end_date=${endDate}&group_by=day`;
  const [counts, breakdown] = await Promise.all([
    requestCodexJson<any>(
      `/backend-api/wham/analytics/daily-workspace-usage-counts?${range}&workspace_user=true`,
      credentials,
    ),
    requestCodexJson<any>(
      `/backend-api/wham/usage/daily-token-usage-breakdown?${range}`,
      credentials,
    ).catch(() => null),
  ]);
  return {
    fetchedAt: Date.now(),
    source: "official-cross-device-credits",
    usdPerCredit: 0.04,
    usdEstimated: true,
    days: (counts.data ?? []).map((row: any) => {
      const credits = Number(
        row.totals?.credits ?? row.totals?.on_demand_credits ?? 0,
      );
      const originalUsd = credits * 0.04;
      const calibrated =
        row.date === startDate && Number.isFinite(tracker.firstDayActualUsd);
      const usd = calibrated ? tracker.firstDayActualUsd : originalUsd;
      const models =
        breakdown?.data?.find((d: any) => d.date === row.date)?.models ?? [];
      const modelTotal = models.reduce(
        (sum: number, m: any) => sum + (Number(m.credits) || 0),
        0,
      );
      return {
        date: row.date,
        credits,
        usd,
        ...(calibrated ? { originalUsd, calibrated: true } : {}),
        models: models.map((m: any) => ({
          ...m,
          usd:
            modelTotal > 0
              ? (usd * (Number(m.credits) || 0)) / modelTotal
              : null,
        })),
      };
    }),
  };
}

export class Quota extends TypertRemoteService {
  private release: (() => Promise<void>) | undefined;
  private busy = false;
  private stopped = false;
  private task: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval>;

  constructor(ctx: any, config: any = {}) {
    super(ctx, "yuQuota");
    ctx.effect(() =>
      ctx.typert.register({
        package: remoteInfo.package,
        face: "host",
        schemas: [],
        invocations: remoteInfo.descriptors,
        model: { services: [], events: [], objects: [] },
      }),
    );
    installCosts(ctx, config);
    this.importHistory();
    this.timer = setInterval(() => this.startTick(), 60000);
    this.timer.unref();
    ctx.on("dispose", async () => {
      this.stopped = true;
      clearInterval(this.timer);
      await this.task;
      await this.release?.().catch(() => {});
      this.release = undefined;
    });
    this.startTick();
  }

  private startTick() {
    if (this.busy || this.stopped) return;
    this.task = this.tick().catch((error: any) =>
      this.ctx.logger.warn(`额度刷新失败：${error.message}`),
    );
  }

  private importHistory() {
    if (readJson<any>(historyFile, null)) return;
    const old: any = readJson(
      join(homedir(), ".pi/agent/quota-history.json"),
      {},
    );
    const history: any = {};
    for (const [key, rows] of Object.entries(old) as any) {
      if (
        !Object.keys(sources).some((p) => key.startsWith(`${p}:`)) ||
        !Array.isArray(rows)
      )
        continue;
      history[key] = rows
        .filter((r: any) => r.timestamp >= Date.now() - 30 * 86400000)
        .map((r: any) => ({
          timestamp: r.timestamp,
          points: [
            {
              name: "week",
              value: r.leftPercent,
              unit: "%",
              resetAt: r.resetAt,
            },
          ],
        }));
    }
    writeJson(historyFile, history);
  }

  async tick() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      if (!this.release)
        this.release = await acquirePoller(() => {
          this.release = undefined;
        });
      if (!this.release || this.stopped) return;
      const snapshot: any = readJson(snapshotFile, { providers: {} });
      const history: any = readJson(historyFile, {});
      await Promise.allSettled(
        Object.entries(sources).map(async ([provider, fetcher]) => {
          const last = snapshot.providers[provider] ?? {};
          try {
            const auth = await providerAuth(this.ctx, provider);
            const key = auth?.auth?.apiKey;
            if (!key) throw new Error("未配置凭据");
            const result = await fetcher(key);
            if (result.kind !== "success") throw new Error(result.kind);
            const account = historyKey(provider, key);
            snapshot.providers[provider] = {
              ...result,
              account,
              checkedAt: Date.now(),
            };
            appendHistory(history, account, pointsFromPayload(result.payload));
          } catch (error: any) {
            snapshot.providers[provider] = {
              ...last,
              checkedAt: Date.now(),
              error: error.message,
            };
          }
        }),
      );
      if (this.stopped || !this.release) return;
      writeJson(snapshotFile, snapshot);
      writeJson(historyFile, history);
      try {
        snapshot.codexLedger = await codexLedger(this.ctx);
      } catch (error: any) {
        snapshot.codexLedger = {
          ...snapshot.codexLedger,
          error: error.message,
          checkedAt: Date.now(),
        };
      }
      if (!this.stopped && this.release) writeJson(snapshotFile, snapshot);
    } finally {
      this.busy = false;
    }
  }

  preferences() {
    return {
      webSearchBackend: settings().webSearchBackend ?? "google",
      classifier: settings().classifier ?? {
        provider: "typesafe",
        model: "jev-latest",
      },
    };
  }
  speed(sessionId: string) {
    return { mode: speedOf(sessionId) };
  }
  setFast(sessionId: string, enabled: boolean) {
    setSpeed(sessionId, enabled ? "fast" : "standard");
    return this.speed(sessionId);
  }
  searchBackend(sessionId: string) {
    return { backend: searchBackendFor(sessionId) };
  }
  savePreferences(value: any) {
    updateSettings(value);
    return { restartRequired: true };
  }
  snapshot() {
    return JSON.parse(
      JSON.stringify({
        ...readJson(snapshotFile, { providers: {} }),
        history: readJson(historyFile, {}),
        sessions: aggregateCosts(costRows(), readParents()),
      }),
    );
  }
}
export function apply(ctx: any, config: any) {
  new Quota(ctx, config);
}
