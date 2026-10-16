import { createModels, createProvider } from "@earendil-works/pi-ai";
import { typesafeProvider } from "@earendil-works/pi-ai/providers/typesafe";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { settings } from "./state.js";
import { providerAuth } from "./auth.js";

export function decisionsRequest(model: string, context: any) {
  return {
    model,
    state: context.state,
    questions: Object.fromEntries(
      Object.entries(context.questions).map(([id, q]: any) => [
        id,
        { ...q, type: q.type === "bool" ? "noul" : q.type },
      ]),
    ),
    ...(context.images?.length ? { images: context.images } : {}),
  };
}
export function decisionsAnswers(body: any, context: any) {
  const answers: any = {};
  for (const [id, q] of Object.entries(context.questions) as any) {
    const a = body.answers?.[id];
    if (!a) throw new Error(`Missing decision: ${id}`);
    answers[id] = q.type === "bool" ? { type: "bool", probability: a.noul } : a;
  }
  return answers;
}
export async function openrouterClassify(
  model: any,
  context: any,
  options: any = {},
) {
  const result: any = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    answers: {},
    stopReason: "stop",
    timestamp: Date.now(),
  };
  try {
    const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(decisionsRequest(model.id, context)),
      signal: options.signal,
    });
    if (!response.ok)
      throw new Error(`OpenRouter Decisions HTTP ${response.status}`);
    const body: any = await response.json();
    if (body.usage) {
      const input = body.usage.prompt_tokens ?? body.usage.input_tokens ?? 0;
      const output =
        body.usage.completion_tokens ?? body.usage.output_tokens ?? 0;
      const total = body.usage.cost;
      result.usage = {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + output,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: typeof total === "number" ? total : 0,
        },
        ...(typeof total !== "number" ? { costUnknown: true } : {}),
      };
    }
    result.answers = decisionsAnswers(body, context);
  } catch (e: any) {
    result.stopReason = options.signal?.aborted ? "aborted" : "error";
    result.errorMessage = e.message;
  }
  return result;
}
export function createClassifierRegistry(ctx: any, config: any = {}) {
  config = { ...settings().classifier, ...config };
  const provider = config?.provider ?? "typesafe";
  const modelId =
    config?.model ??
    (provider === "openrouter"
      ? "~typesafe/jev-latest"
      : provider === "openai"
        ? "gpt-6-luna"
        : "jev-latest");
  const models = createModels({
    credentials: {
      read: async (id: string) => {
        const a = await providerAuth(ctx, id);
        return a?.auth?.apiKey
          ? { type: "api_key", key: a.auth.apiKey }
          : undefined;
      },
      list: async () => [],
      modify: async () => {
        throw new Error("Classifier auth is read-only");
      },
      delete: async () => {},
    },
  });
  models.setProvider(typesafeProvider());
  models.setProvider(openaiProvider());
  const routerModel: any = {
    id: modelId,
    name: modelId,
    provider: "openrouter",
    type: "classifier",
    api: "openrouter-decisions",
    baseUrl: "https://openrouter.ai/api/alpha",
    input: ["text", "image"],
    contextWindow: 1000000,
    cost: { input: 0, output: 0 },
  };
  models.setProvider(
    createProvider({
      id: "openrouter",
      auth: {
        apiKey: {
          name: "OpenRouter API key",
          resolve: async ({ credential }: any) =>
            credential?.key ? { auth: { apiKey: credential.key } } : undefined,
        },
      },
      models: [routerModel],
      classifiers: { "openrouter-decisions": { classify: openrouterClassify } },
    } as any),
  );
  return {
    findOfType: () => models.getModelOfType("classifier", provider, modelId),
    classify: async (model: any, request: any, options: any) => {
      const result = await models.classify(model, request, options);
      ctx.emit("yu-extensions/tool-usage", {
        sessionId: config.sessionId,
        provider: model.provider,
        model: model.id,
        usage: result.usage,
      });
      return result;
    },
  };
}
