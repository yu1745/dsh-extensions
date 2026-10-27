import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, readJson, writeJson } from "./state.js";
import { speedOf } from "./speed-context.js";

/**
 * DeepSeek's exclusive billing currency is CNY unless a caller explicitly
 * asks for the USD card; official rows are never converted by exchange rate.
 */
export function billingCurrency(provider: string): "USD" | "CNY" {
  return provider === "deepseek-official" || provider === "deepseek"
    ? "CNY"
    : "USD";
}
function deepseekPeak(time: number, currency: "USD" | "CNY") {
  // DeepSeek publishes USD peaks in UTC and CNY peaks in Beijing time; China
  // has no DST, so a fixed +8h shift is exact. The published cards exempt
  // Chinese statutory holidays; like the existing USD estimate this table
  // follows the weekly window only.
  const date = new Date(currency === "CNY" ? time + 8 * 3600000 : time);
  const hour = date.getUTCHours(),
    day = date.getUTCDay();
  return (
    day >= 1 &&
    day <= 5 &&
    (currency === "CNY"
      ? (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
      : (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))
  );
}
/** Per-million-token rates from DeepSeek's official card (2026-10-16). */
export function deepseekRates(
  model: string,
  time: number,
  currency: "USD" | "CNY" = "USD",
) {
  const peak = deepseekPeak(time, currency);
  const pro = /^deepseek-(?:v4(?:\.\d+)?-)?pro$/i.test(model);
  if (
    !pro &&
    !/^deepseek-(?:v4(?:\.\d+)?-)?flash(?:-vision-exp)?$/i.test(model)
  )
    return undefined;
  const rates =
    currency === "CNY"
      ? pro
        ? { input: 4.5, output: 13.5, cacheRead: 0.15, cacheWrite: 0 }
        : { input: 1, output: 4, cacheRead: 0.02, cacheWrite: 0 }
      : pro
        ? { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 }
        : { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 };
  return Object.fromEntries(
    Object.entries(rates).map(([key, value]) => [key, value * (peak ? 2 : 1)]),
  );
}

export type CostParts = {
  cacheRead: number;
  input: number;
  output: number;
  cacheWrite: number;
};
export function emptyCostParts(): CostParts {
  return { cacheRead: 0, input: 0, output: 0, cacheWrite: 0 };
}
/** Official Standard API card, USD / 1M tokens (2026-10-27).
 * https://developers.openai.com/api/docs/models/gpt-6.1-terra
 * Over 272K input tokens: input/cache rates double, output increases 1.5x.
 * Fast requests use 2x these rates; Ultrafast stays unknown.
 */
const codexRates: Record<string, any> = {
  "gpt-6.1-terra": {
    input: 1,
    output: 5,
    cacheRead: 0.05,
    cacheWrite: 1.25, // 30-minute retention; 12-hour writes cost $2.50.
    tiers: [
      {
        inputTokensAbove: 272_000,
        input: 2,
        output: 7.5,
        cacheRead: 0.1,
        cacheWrite: 2.5,
      },
    ],
  },
};
/** Price one usage record and keep the per-token-category subtotals. */
export function priceBreakdown(
  provider: string,
  model: string,
  usage: any,
  time: number,
  ratesOverride?: any,
  currency: "USD" | "CNY" = billingCurrency(provider),
): { amount: number; parts: CostParts } | null {
  let rate =
    ratesOverride ??
    (["deepseek", "deepseek-official"].includes(provider)
      ? deepseekRates(model, time, currency)
      : ((provider === "openai-codex" ? codexRates[model] : undefined) ??
        getBuiltinModels(provider)?.find((m: any) => m.id === model)?.cost));
  if (
    !rate ||
    (!ratesOverride &&
      !Object.values(rate).some((v) => typeof v === "number" && v > 0))
  )
    return null;
  const input = usage.inputTokens,
    output = usage.outputTokens,
    read = usage.cacheReadTokens ?? 0,
    write = usage.cacheWriteTokens ?? 0;
  if (![input, output, read, write].every((n) => Number.isFinite(n) && n >= 0))
    return null;
  const aggregateInput = input + read + write;
  for (const tier of [...(rate.tiers ?? [])].sort(
    (a: any, b: any) => a.inputTokensAbove - b.inputTokensAbove,
  )) {
    if (aggregateInput > tier.inputTokensAbove) rate = { ...rate, ...tier };
  }
  const rates = [
    rate.input,
    rate.output,
    rate.cacheRead ?? rate.input,
    rate.cacheWrite ?? rate.input,
  ];
  if (!rates.every((n) => Number.isFinite(n) && n >= 0)) return null;
  // Both DSH adapters report uncached input separately from cache read/write.
  const parts = {
    input: (input * rates[0]) / 1e6,
    output: (output * rates[1]) / 1e6,
    cacheRead: (read * rates[2]) / 1e6,
    cacheWrite: (write * rates[3]) / 1e6,
  };
  return {
    amount: parts.input + parts.output + parts.cacheRead + parts.cacheWrite,
    parts,
  };
}
/** Official model cards specify Fast at 2x applicable Standard API rates.
 * https://developers.openai.com/api/docs/models/gpt-6-astra
 * https://developers.openai.com/api/docs/models/gpt-6.1-sol
 * https://developers.openai.com/api/docs/models/gpt-6-sol
 * https://developers.openai.com/api/docs/models/gpt-6.1-terra
 * https://developers.openai.com/api/docs/models/gpt-6-luna
 * This estimates the requested tier; Codex subscription credits are separate.
 */
const fastModels = new Set([
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6.1-terra",
  "gpt-6-luna",
]);
function fastEstimate(model: string, usage: any, time: number) {
  if (!fastModels.has(model)) return null;
  const standard = priceBreakdown("openai-codex", model, usage, time);
  if (!standard) return null;
  return {
    amount: standard.amount * 2,
    parts: Object.fromEntries(
      Object.entries(standard.parts).map(([key, value]) => [key, value * 2]),
    ) as CostParts,
  };
}
export function priceUsage(
  provider: string,
  model: string,
  usage: any,
  time: number,
  ratesOverride?: any,
  currency: "USD" | "CNY" = billingCurrency(provider),
) {
  return (
    priceBreakdown(provider, model, usage, time, ratesOverride, currency)
      ?.amount ?? null
  );
}

export const costDir = join(dataDir, "costs");
export function recordCost(row: any) {
  mkdirSync(costDir, { recursive: true, mode: 0o700 });
  const sessionKey = createHash("sha256")
    .update(String(row.sessionId))
    .digest("hex");
  // One O_APPEND write per request, so simultaneous processes never replace a ledger.
  appendFileSync(
    join(costDir, `${sessionKey}.jsonl`),
    `${JSON.stringify(row)}\n`,
    { mode: 0o600 },
  );
}
export function costRows() {
  try {
    return readdirSync(costDir).flatMap((name) => {
      if (name.endsWith(".json"))
        return [readJson<any>(join(costDir, name), null)].filter(Boolean);
      if (!name.endsWith(".jsonl")) return [];
      return readFileSync(join(costDir, name), "utf8")
        .split("\n")
        .flatMap((line) => {
          if (!line) return [];
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
    });
  } catch {
    return [];
  }
}

/**
 * Trust stored category parts only when they are finite and non-negative, then
 * scale them to the recorded amount so a rate override or tier cannot make the
 * breakdown disagree with the total.
 */
export function scaleCostParts(
  parts: any,
  amount: number | null,
): CostParts | null {
  if (!parts || amount === null) return null;
  const result = emptyCostParts();
  for (const key of Object.keys(result) as (keyof CostParts)[]) {
    const value = parts[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      return null;
    result[key] = value;
  }
  const sum =
    result.input + result.output + result.cacheRead + result.cacheWrite;
  if (!Number.isFinite(sum) || sum <= 0) return null;
  const ratio = amount / sum;
  for (const key of Object.keys(result) as (keyof CostParts)[])
    result[key] *= ratio;
  return result;
}
/**
 * Prefer stored category parts; otherwise re-price the row's stored usage with
 * the requested currency and scale that split to the recorded amount. This
 * also backfills rows written by an earlier CNY build before parts existed.
 */
function rowParts(
  row: any,
  amount: number | null,
  currency: "USD" | "CNY",
): CostParts | null {
  const stored = scaleCostParts(row.parts, amount);
  if (stored) return stored;
  if (amount === null || !row.usage) return null;
  const priced = priceBreakdown(
    row.provider,
    row.model,
    row.usage,
    row.startedAt ?? Date.now(),
    undefined,
    currency,
  );
  return priced ? scaleCostParts(priced.parts, amount) : null;
}
/**
 * Resolve one ledger row into an amount, billing currency and category parts.
 * Current rows carry all three. Legacy rows predate the CNY card: DeepSeek
 * official rows are re-priced from their stored usage with the exact CNY card
 * (never an exchange rate), while every other legacy row keeps its USD amount
 * and gets a category split scaled to that amount.
 */
export function normalizeCost(row: any): {
  amount: number | null;
  currency: "USD" | "CNY";
  parts: CostParts | null;
} {
  if (row.currency === "USD" || row.currency === "CNY") {
    // Older Fast rows saved usage but intentionally left the amount unknown.
    // Recover their API estimate without changing the append-only ledger.
    const fast =
      row.currency === "USD" &&
      row.provider === "openai-codex" &&
      row.requestedSpeed === "fast" &&
      row.amount === null &&
      row.usage
        ? fastEstimate(row.model, row.usage, row.startedAt ?? Date.now())
        : null;
    const amount =
      typeof row.amount === "number" ? row.amount : (fast?.amount ?? null);
    return {
      amount,
      currency: row.currency,
      parts: fast?.parts ?? rowParts(row, amount, row.currency),
    };
  }
  if (row.amount !== undefined) {
    const amount = typeof row.amount === "number" ? row.amount : null;
    return {
      amount,
      currency: "USD",
      parts: rowParts(row, amount, "USD"),
    };
  }
  const time = row.startedAt ?? Date.now();
  if (
    row.usage &&
    typeof row.usd === "number" &&
    billingCurrency(row.provider) === "CNY"
  ) {
    const priced = priceBreakdown(
      row.provider,
      row.model,
      row.usage,
      time,
      undefined,
      "CNY",
    );
    return {
      amount: priced?.amount ?? null,
      currency: "CNY",
      parts: priced?.parts ?? null,
    };
  }
  const amount = typeof row.usd === "number" ? row.usd : null;
  const priced =
    amount !== null && row.usage
      ? priceBreakdown(
          row.provider,
          row.model,
          row.usage,
          time,
          undefined,
          "USD",
        )
      : null;
  return {
    amount,
    currency: "USD",
    parts: priced ? scaleCostParts(priced.parts, amount) : null,
  };
}
export function aggregateCosts(
  rows: any[],
  parents: Record<string, string> = {},
) {
  const sessions: any = {};
  for (const row of rows) {
    const { amount, currency, parts } = normalizeCost(row);
    const session = (sessions[row.sessionId] ??= {
      sessionId: row.sessionId,
      amounts: {},
      totalAmounts: {},
      parts: {},
      totalParts: {},
      usd: 0,
      unknown: 0,
      requests: 0,
      parentSessionId: parents[row.sessionId],
    });
    session.requests++;
    if (amount === null) session.unknown++;
    else {
      session.amounts[currency] = (session.amounts[currency] ?? 0) + amount;
      if (currency === "USD") session.usd += amount;
      if (parts) {
        const bucket = (session.parts[currency] ??= emptyCostParts());
        bucket.cacheRead += parts.cacheRead;
        bucket.input += parts.input;
        bucket.output += parts.output;
        bucket.cacheWrite += parts.cacheWrite;
      }
    }
  }
  for (const session of Object.values(sessions) as any[]) {
    session.totalAmounts = { ...session.amounts };
    session.totalParts = Object.fromEntries(
      Object.entries(session.parts).map(([currency, parts]: any) => [
        currency,
        { ...parts },
      ]),
    );
    session.totalUsd = session.usd;
    session.totalUnknown = session.unknown;
  }
  for (const session of Object.values(sessions) as any[]) {
    let parentId = parents[session.sessionId];
    const seen = new Set([session.sessionId]);
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = (sessions[parentId] ??= {
        sessionId: parentId,
        amounts: {},
        totalAmounts: {},
        parts: {},
        totalParts: {},
        usd: 0,
        unknown: 0,
        requests: 0,
        totalUsd: 0,
        totalUnknown: 0,
        parentSessionId: parents[parentId],
      });
      for (const [currency, amount] of Object.entries(session.amounts))
        parent.totalAmounts[currency] =
          (parent.totalAmounts[currency] ?? 0) + (amount as number);
      for (const [currency, parts] of Object.entries(session.parts) as [
        string,
        CostParts,
      ][]) {
        const bucket = (parent.totalParts[currency] ??= emptyCostParts());
        bucket.cacheRead += parts.cacheRead;
        bucket.input += parts.input;
        bucket.output += parts.output;
        bucket.cacheWrite += parts.cacheWrite;
      }
      parent.totalUsd += session.usd;
      parent.totalUnknown += session.unknown;
      parentId = parents[parentId];
    }
  }
  return Object.values(sessions);
}

export function installCosts(ctx: any, config: any = {}) {
  ctx.on("llm/stream", async function* (options: any, next: Function) {
    const startedAt = Date.now();
    const mode =
      options.provider === "openai-codex"
        ? speedOf(options.sessionId)
        : undefined;
    const override = config.rates?.[options.provider]?.[options.model];
    const currency = billingCurrency(options.provider);
    let usage: any;
    try {
      for await (const chunk of next()) {
        if (chunk.type === "usage") usage = chunk.usage;
        yield chunk;
      }
    } finally {
      if (usage) {
        const priced =
          mode === "fast" && !override
            ? fastEstimate(options.model, usage, startedAt)
            : mode === "ultrafast" && !override
              ? null
              : priceBreakdown(
                  options.provider,
                  options.model,
                  usage,
                  startedAt,
                  override,
                  currency,
                );
        recordCost({
          id: randomUUID(),
          sessionId: options.sessionId ?? "auxiliary",
          provider: options.provider,
          model: options.model,
          startedAt,
          usage,
          ...(mode ? { requestedSpeed: mode } : {}),
          amount: priced?.amount ?? null,
          parts: priced?.parts ?? null,
          currency,
          source: "provider-usage-estimate",
        });
      }
    }
  });
  ctx.on("yu-extensions/tool-usage", (row: any) => {
    const cost = row.usage?.cost;
    const amount = row.usage?.costUnknown ? null : (cost?.total ?? null);
    recordCost({
      id: randomUUID(),
      sessionId: row.sessionId ?? "auxiliary",
      provider: row.provider,
      model: row.model,
      startedAt: Date.now(),
      usage: row.usage,
      amount,
      parts: cost
        ? {
            cacheRead: cost.cacheRead ?? 0,
            input: cost.input ?? 0,
            output: cost.output ?? 0,
            cacheWrite: cost.cacheWrite ?? 0,
          }
        : null,
      currency: "USD",
      source: "classifier",
    });
  });
  const knownParents = new Set<string>();
  const recordParent = (session: any) => {
    if (!session.header.parentSession || knownParents.has(session.id)) return;
    writeJson(join(dataDir, "parents", `${session.id}.json`), {
      id: session.id,
      parent: session.header.parentSession,
    });
    knownParents.add(session.id);
  };
  ctx.on("session/created", recordParent);
  ctx.on("session/event", recordParent);
}
export function readParents() {
  try {
    return Object.fromEntries(
      readdirSync(join(dataDir, "parents"))
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
          const row: any = readJson(join(dataDir, "parents", name), {});
          return [row.id, row.parent];
        }),
    );
  } catch {
    return {};
  }
}
