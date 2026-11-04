import type { FetchResult } from "./vendor/quota-footer/types.js";
import { REQUEST_TIMEOUT_MS } from "./vendor/quota-footer/utils.js";

// Official API: https://github.com/anomalyco/opencode/pull/16513
export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

export function parseOpenCodeGoUsage(body: any, now = Date.now()): FetchResult {
  if (!body || typeof body !== "object" || body.type === "error")
    return { kind: "unavailable", at: now };
  const buckets = [
    ["rollingUsage", "5h"],
    ["weeklyUsage", "周"],
    ["monthlyUsage", "月"],
  ].flatMap(([key, label]) => {
    const window = body.usage?.[key.replace("Usage", "")] ?? body[key];
    const usedPercent = window?.percent ?? window?.usagePercent;
    if (
      !window ||
      !["ok", "rate-limited"].includes(window.status) ||
      typeof usedPercent !== "number" ||
      !Number.isFinite(usedPercent)
    )
      return [];
    const resetMs =
      typeof window.resetsAt === "string"
        ? Date.parse(window.resetsAt)
        : typeof window.resetInSec === "number" &&
            Number.isFinite(window.resetInSec) &&
            window.resetInSec >= 0
          ? now + window.resetInSec * 1000
          : undefined;
    return [
      {
        label,
        leftPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
        status: window.status,
        ...(resetMs !== undefined &&
        Number.isFinite(new Date(resetMs).getTime())
          ? { resetTime: new Date(resetMs).toISOString() }
          : {}),
      },
    ];
  });
  if (!buckets.length) return { kind: "unavailable", at: now };
  return {
    kind: "success",
    fetchedAt: now,
    payload: {
      buckets,
      ...(typeof body.useBalance === "boolean"
        ? { useBalance: body.useBalance }
        : {}),
    },
  };
}

export async function fetchOpenCodeGo(apiKey: string): Promise<FetchResult> {
  try {
    const response = await fetch(OPENCODE_GO_USAGE_URL, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
    if (response.status === 401) return { kind: "auth_error", at: Date.now() };
    if (response.status === 403)
      throw new Error("当前凭据没有 OpenCode Go 订阅权限");
    if (response.status === 429)
      return { kind: "rate_limited", at: Date.now() };
    if (!response.ok) return { kind: "unavailable", at: Date.now() };
    return parseOpenCodeGoUsage(await response.json());
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "当前凭据没有 OpenCode Go 订阅权限"
    )
      throw error;
    return { kind: "unavailable", at: Date.now() };
  }
}
