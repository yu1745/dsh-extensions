import { join } from "node:path";
import { isQuotaExceededError } from "@deepseek-ai/dsh-llm";
import { dataDir, readJson, writeJson } from "./state.js";

import {
  fallbackConfigSchema,
  type FallbackConfig,
  type Route,
} from "./fallback-schema.js";
export type { FallbackConfig, Route } from "./fallback-schema.js";
export type Block = { failedAt: number; until: number; reason: string };
export const fallbackFile = join(dataDir, "model-fallback.json");
export const fallbackStateFile = join(dataDir, "model-fallback-state.json");
export const quotaFile = join(dataDir, "quota.json");
export const routeKey = (route: Route) =>
  JSON.stringify([route.provider, route.model]);
export const sameRoute = (a?: Route | null, b?: Route | null) =>
  Boolean(a && b && a.provider === b.provider && a.model === b.model);
export function fallbackConfig(): FallbackConfig {
  const parsed = fallbackConfigSchema.safeParse(readJson(fallbackFile, null));
  return parsed.success ? parsed.data : { enabled: false, models: [] };
}
export function routes(config: FallbackConfig): Route[] {
  return config.models;
}
export function saveFallbackConfig(value: unknown) {
  const config = fallbackConfigSchema.parse(value);
  writeJson(fallbackFile, config);
  return config;
}
export function quotaFailure(failure: any) {
  if (
    !failure ||
    [
      "ABORTED",
      "CONTEXT_WINDOW_EXCEEDED",
      "INVALID_CREDENTIAL",
      "AUTH",
      "MISSING_CREDENTIAL",
    ].includes(failure.code)
  )
    return false;
  return (
    ["QUOTA", "ACCOUNT_QUOTA"].includes(failure.code) ||
    isQuotaExceededError(String(failure.message ?? "")) ||
    /(?:usage_limit_reached|insufficient_quota|exhausted.*(?:5.?h|weekly)|(?:5.?h|weekly).*limit|(?:已达到|达到).{0,12}(?:小时|周).{0,12}使用上限|额度.{0,8}(?:耗尽|不足|用完)|余额不足)/i.test(
      String(failure.message ?? ""),
    )
  );
}
function timestamp(value: any): number | undefined {
  if (typeof value === "string") {
    const number = Number(value);
    if (Number.isFinite(number)) value = number;
    else {
      const time = Date.parse(value);
      return Number.isFinite(time) ? time : undefined;
    }
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return undefined;
  return value < 1e11 ? value * 1000 : value;
}
/** Only use exact account-wide windows, never a different model family's pool. */
export function quotaStatus(route: Route, snapshot: any, now = Date.now()) {
  const id =
    route.provider === "deepseek-official" ? "deepseek" : route.provider;
  const entry = snapshot?.providers?.[id];
  const checkedAt = entry?.fetchedAt ?? entry?.at ?? entry?.checkedAt;
  if (
    !entry ||
    entry.error ||
    entry.kind !== "success" ||
    !Number.isFinite(checkedAt) ||
    now - checkedAt > 5 * 60_000 ||
    checkedAt > now + 60_000
  )
    return {
      known: false,
      exhausted: false,
      checkedAt: 0,
      until: undefined as number | undefined,
    };
  const p = entry.payload ?? {};
  let windows: any[] = [];
  let exhausted = false;
  if (id === "openai-codex") {
    windows = [p.primary, p.secondary].filter(Boolean);
    exhausted = p.allowed === false || p.limitReached === true;
  } else if (id === "zai-coding-cn") {
    windows = [
      { leftPercent: p.leftPercent, resetAt: p.nextResetTime },
      { leftPercent: p.weekLeftPercent, resetAt: p.weekNextResetTime },
    ];
  } else if (id === "minimax-cn")
    windows = [p.interval, p.weekly].filter(Boolean);
  else if (id === "deepseek")
    exhausted =
      p.available === false || (typeof p.total === "number" && p.total <= 0);
  else if (id === "antigravity") {
    // The existing quota poller stores Gemini pools only, not Claude pools.
    if (
      !/gemini/i.test(route.model) ||
      !(p.buckets ?? []).some((b: any) => /gemini/i.test(b.label))
    )
      return {
        known: false,
        exhausted: false,
        checkedAt,
        until: undefined as number | undefined,
      };
    windows = p.buckets;
  } else
    return {
      known: false,
      exhausted: false,
      checkedAt,
      until: undefined as number | undefined,
    };
  const empty = windows.filter(
    (w) => typeof w.leftPercent === "number" && w.leftPercent <= 0,
  );
  const activeEmpty = empty.filter((w) => {
    const reset = timestamp(w.resetAt ?? w.endAt ?? w.resetTime);
    return reset === undefined || reset > now;
  });
  const resetTimes = activeEmpty
    .map((w) => timestamp(w.resetAt ?? w.endAt ?? w.resetTime))
    .filter((t): t is number => t !== undefined && t > now);
  // Flags can lag a just-passed reset; let an actual request verify recovery.
  if (exhausted && empty.length > 0 && activeEmpty.length === 0)
    exhausted = false;
  return {
    known: true,
    exhausted: exhausted || activeEmpty.length > 0,
    checkedAt,
    until: resetTimes.length ? Math.max(...resetTimes) : undefined,
  };
}
export function blockedRoute(
  route: Route,
  blocks: Record<string, Block>,
  snapshot: any,
  now = Date.now(),
) {
  const quota = quotaStatus(route, snapshot, now);
  if (quota.exhausted) return { reason: "额度耗尽", until: quota.until };
  const block = blocks[routeKey(route)];
  if (
    block &&
    block.until > now &&
    !(quota.known && quota.checkedAt > block.failedAt)
  )
    return block;
  return undefined;
}
export function makeBlock(
  route: Route,
  failure: any,
  snapshot: any,
  now = Date.now(),
): Block {
  const quota = quotaStatus(route, snapshot, now);
  const delay = failure.providerRetryAfterMs;
  const retryAt =
    typeof delay === "number" && Number.isFinite(delay) && delay > 0
      ? now + Math.min(delay, 30 * 86400_000)
      : undefined;
  return {
    failedAt: now,
    until: Math.max(
      now + 1000,
      retryAt ?? 0,
      quota.until ?? 0,
      retryAt === undefined && quota.until === undefined ? now + 5 * 60_000 : 0,
    ),
    reason: "额度耗尽",
  };
}
