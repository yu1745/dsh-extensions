import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, readJson, writeJson } from "./state.js";
import { speedOf } from "./speed-context.js";

/** USD per million tokens, from DeepSeek's official USD rate card (2026-10-16). */
export function deepseekRates(model: string, time: number) {
  const date = new Date(time),
    hour = date.getUTCHours(),
    day = date.getUTCDay();
  const peak =
    day >= 1 &&
    day <= 5 &&
    ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
  const pro = /^deepseek-(?:v4(?:\.\d+)?-)?pro$/i.test(model);
  if (
    !pro &&
    !/^deepseek-(?:v4(?:\.\d+)?-)?flash(?:-vision-exp)?$/i.test(model)
  )
    return undefined;
  const rates = pro
    ? { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 }
    : { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 };
  return Object.fromEntries(
    Object.entries(rates).map(([key, value]) => [key, value * (peak ? 2 : 1)]),
  );
}

export function priceUsage(
  provider: string,
  model: string,
  usage: any,
  time: number,
  ratesOverride?: any,
) {
  let rate =
    ratesOverride ??
    (["deepseek", "deepseek-official"].includes(provider)
      ? deepseekRates(model, time)
      : getBuiltinModels(provider)?.find((m: any) => m.id === model)?.cost);
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
  return (
    (input * rates[0] +
      output * rates[1] +
      read * rates[2] +
      write * rates[3]) /
    1e6
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

export function aggregateCosts(
  rows: any[],
  parents: Record<string, string> = {},
) {
  const sessions: any = {};
  for (const row of rows) {
    const session = (sessions[row.sessionId] ??= {
      sessionId: row.sessionId,
      usd: 0,
      unknown: 0,
      requests: 0,
      parentSessionId: parents[row.sessionId],
    });
    session.requests++;
    if (row.usd === null) session.unknown++;
    else session.usd += row.usd;
  }
  for (const session of Object.values(sessions) as any[]) {
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
        usd: 0,
        unknown: 0,
        requests: 0,
        totalUsd: 0,
        totalUnknown: 0,
        parentSessionId: parents[parentId],
      });
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
    let usage: any;
    try {
      for await (const chunk of next()) {
        if (chunk.type === "usage") usage = chunk.usage;
        yield chunk;
      }
    } finally {
      if (usage)
        recordCost({
          id: randomUUID(),
          sessionId: options.sessionId ?? "auxiliary",
          provider: options.provider,
          model: options.model,
          startedAt,
          usage,
          ...(mode ? { requestedSpeed: mode } : {}),
          usd:
            mode && mode !== "standard" && !override
              ? null
              : priceUsage(
                  options.provider,
                  options.model,
                  usage,
                  startedAt,
                  override,
                ),
          source: "provider-usage-estimate",
        });
    }
  });
  ctx.on("yu-extensions/tool-usage", (row: any) =>
    recordCost({
      id: randomUUID(),
      sessionId: row.sessionId ?? "auxiliary",
      provider: row.provider,
      model: row.model,
      startedAt: Date.now(),
      usage: row.usage,
      usd: row.usage?.costUnknown ? null : (row.usage?.cost?.total ?? null),
      source: "classifier",
    }),
  );
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
