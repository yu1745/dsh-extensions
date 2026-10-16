// Adapted from yu1745/pi-extensions (MIT).
const BASE = "https://copilot.tencent.com";
const FALLBACK_EFFORTS: Record<string, string[]> = {
  deepseek: ["low", "high", "max"],
};
/** 严格映射：只有官方 supportedEfforts 声明的档位可选（pi 语义 null=隐藏该档），
 *  不做就近降档——medium 未声明就不可选，避免把 xhigh 悄悄变成 max。
 *  off 仅在 canDisableThinking 时映射为 "none"（官方关闭思考的取值）。 */
function piThinkingLevelMap(
  supported?: string[],
  canDisableThinking?: boolean,
): Record<string, string | null> | undefined {
  if (!supported?.length) return undefined;
  const has = (l: string) => supported.includes(l);
  return {
    off: canDisableThinking ? "none" : null,
    minimal: null,
    low: has("low") ? "low" : null,
    medium: has("medium") ? "medium" : null,
    high: has("high") ? "high" : null,
    xhigh: has("xhigh") ? "xhigh" : null,
    max: has("max") ? "max" : null,
  };
}
/** "x0.03 credits" → " (x0.03)"；积分制不分输入/输出/缓存，只展示倍率，cost 留零 */
function rateSuffix(credits?: string): string {
  const m = /^(x[\d.]+)/.exec(String(credits ?? "").trim());
  return m ? ` (${m[1]})` : "";
}

/** 扒掉 id 里的倍率后缀，还原上游真实 model id（"deepseek-v4.1-flash (x0.03)" → "deepseek-v4.1-flash"） */
const RATE_ID_RE = /\s*\(x[\d.]+\)$/;
function stripRateId(id: string): string {
  return id.replace(RATE_ID_RE, "");
}

export function modelsFromConfig(cfg: any): Model2[] {
  const list: any[] = cfg?.data?.models ?? [];
  const out: Model2[] = [];
  for (const m of list) {
    if (!m?.supportsToolCall || m?.tags?.length) continue; // 跳过非 chat（文生图等带 tags）
    const id: string = m.id;
    const efforts =
      m.reasoning?.supportedEfforts ??
      FALLBACK_EFFORTS[id.split("-")[0]] ??
      undefined;
    // 未声明 supportedEfforts 的（DeepSeek 系）视为不可关闭思考
    const defaultEffort: string =
      m.reasoning?.defaultEffort ?? m.reasoning?.effort ?? "high";
    out.push({
      provider: "codebuddy",
      api: "openai-completions" as const,
      baseUrl: `${BASE}/v2`,
      id, // id 带倍率 → footer / /models 全程可见
      name: `${m.name ?? id}${rateSuffix(m.credits)}`,
      upstreamId: id, // 上游真实 id
      reasoning: !!m.supportsReasoning,
      input: m.supportsImages ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.maxInputTokens ?? m.maxAllowedSize ?? 128_000,
      maxTokens: m.maxOutputTokens ?? 32_000,
      samplingParams:
        m.temperature != null ? { temperature: m.temperature } : undefined,
      thinkingLevelMap: piThinkingLevelMap(
        efforts,
        m.reasoning?.canDisableThinking,
      ),
      defaultEffort,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: "max_tokens",
        requiresReasoningContentOnAssistantMessages: true,
      },
    });
  }
  return out;
}
type Model2 = {
  provider: string;
  api: "openai-completions";
  baseUrl: string;
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: Record<string, number>;
  contextWindow: number;
  maxTokens: number;
  samplingParams?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, string | null>;
  defaultEffort?: string;
  upstreamId?: string;
  compat: Record<string, unknown>;
};
