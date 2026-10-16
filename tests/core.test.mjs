import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const home = mkdtempSync(join(tmpdir(), "dsh-extensions-tests-"));
process.env.DSH_HOME = home;
const { deepseekRates, priceUsage, aggregateCosts } = await import(
  "../lib/costs.js"
);
const { appendHistory, pointsFromPayload, historyKey } = await import(
  "../lib/quota.js"
);
const {
  decisionsRequest,
  decisionsAnswers,
  openrouterClassify,
  createClassifierRegistry,
} = await import("../lib/classifiers.js");
const {
  speedOf,
  setSpeed,
  inheritSpeed,
  activateSpeedModes,
  codexServiceOptions,
} = await import("../lib/speed-context.js");
const { createBridge } = await import("../lib/bridge.js");
const { apply: searchApply, Config: SearchConfig } = await import(
  "../lib/web-search.js"
);
const { apply: readerApply, Config: ReaderConfig } = await import(
  "../lib/web-reader.js"
);
const { apply: webToolsApply, Config: WebConfig } = await import(
  "../lib/web-tools.js"
);
const { Extensions } = await import("../lib/index.js");
const { Context } = await import("@deepseek-ai/cordis");
const { assertSupportedJsonSchema } = await import("@deepseek-ai/dsh-tools");

test.after(() => rmSync(home, { recursive: true, force: true }));
test("DeepSeek uses exact USD rates and UTC weekday peak boundaries", () => {
  const at = (day, h) => Date.UTC(2026, 9, day, h);
  assert.equal(deepseekRates("deepseek-flash", at(16, 0)).input, 0.15);
  assert.equal(deepseekRates("deepseek-flash", at(16, 1)).input, 0.3);
  assert.equal(deepseekRates("deepseek-flash", at(16, 4)).input, 0.15);
  assert.equal(deepseekRates("deepseek-flash", at(16, 6)).cacheRead, 0.006);
  assert.equal(deepseekRates("deepseek-flash", at(16, 10)).output, 0.6);
  assert.equal(deepseekRates("deepseek-v4-pro", at(16, 2)).input, 1.32);
  assert.equal(deepseekRates("deepseek-v4-pro", at(17, 2)).output, 1.98);
  assert.equal(deepseekRates("unknown", at(16, 2)), undefined);
  const usage = { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6 };
  assert.equal(
    priceUsage("deepseek-official", "deepseek-flash", usage, at(16, 1)),
    1.506,
  );
  assert.equal(priceUsage("unknown", "anything", usage, at(16, 1)), null);
});
test("parent and nested child totals count each request once", () => {
  const rows = [
    { sessionId: "p", usd: 1 },
    { sessionId: "c", usd: 2 },
    { sessionId: "g", usd: 3 },
    { sessionId: "g", usd: null },
  ];
  const result = Object.fromEntries(
    aggregateCosts(rows, { c: "p", g: "c" }).map((r) => [r.sessionId, r]),
  );
  assert.equal(result.p.totalUsd, 6);
  assert.equal(result.c.totalUsd, 5);
  assert.equal(result.g.totalUsd, 3);
  assert.equal(result.p.totalUnknown, 1);
});
test("quota history records changes, reset changes and heartbeat, retaining last good data", () => {
  const now = Date.now();
  const history = {};
  appendHistory(history, "a", [{ name: "week", value: 80, unit: "%" }], now);
  appendHistory(
    history,
    "a",
    [{ name: "week", value: 80, unit: "%" }],
    now + 60000,
  );
  assert.equal(history.a.length, 1);
  appendHistory(
    history,
    "a",
    [{ name: "week", value: 75, unit: "%" }],
    now + 120000,
  );
  assert.equal(history.a.length, 2);
  appendHistory(
    history,
    "a",
    [{ name: "week", value: 75, unit: "%" }],
    now + 5 * 3600000,
  );
  assert.equal(history.a.length, 3);
  assert.deepEqual(
    pointsFromPayload({
      interval: { leftPercent: 90 },
      weekly: { leftPercent: 60 },
    }).map((p) => p.value),
    [90, 60],
  );
  assert.equal(
    historyKey(
      "antigravity",
      JSON.stringify({ token: "secret", projectId: "p" }),
    ),
    "antigravity:p",
  );
});
test("Codex speed is isolated per session and inherited as a snapshot", () => {
  const stop = activateSpeedModes();
  setSpeed("parent", "fast");
  inheritSpeed("child", "parent");
  setSpeed("parent", "ultrafast");
  assert.equal(speedOf("child"), "fast");
  assert.deepEqual(
    codexServiceOptions({ provider: "openai-codex", sessionId: "child" }),
    { serviceTier: "priority" },
  );
  assert.deepEqual(
    codexServiceOptions({ provider: "other", sessionId: "child" }),
    {},
  );
  stop();
  assert.deepEqual(
    codexServiceOptions({ provider: "openai-codex", sessionId: "child" }),
    {},
  );
});
test("OpenRouter Decisions keeps arbitrary model IDs and maps bool/noul", () => {
  const context = {
    state: { text: "loaded" },
    questions: {
      ready: {
        type: "bool",
        instructions: "Ready?",
        criteria: { true: "ready", false: "not ready" },
      },
    },
  };
  const body = decisionsRequest("microsoft/microsoft-decision-1", context);
  assert.equal(body.model, "microsoft/microsoft-decision-1");
  assert.equal(body.questions.ready.type, "noul");
  assert.deepEqual(
    decisionsAnswers(
      { answers: { ready: { type: "noul", noul: 0.9 } } },
      context,
    ),
    { ready: { type: "bool", probability: 0.9 } },
  );
});
function fakeContext() {
  const definitions = new Map(),
    handlers = new Map(),
    tools = new Map(),
    prompts = new Map();
  const ctx = {
    credentials: {
      readRecord: async () => undefined,
      resolve: async () => undefined,
    },
    get(n) {
      return this[n];
    },
    logger: { info() {} },
    emit(event, ...args) {
      for (const f of [...(handlers.get(event) ?? [])]) f(...args);
    },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    tools: {
      register(tool) {
        assert.ok(!tools.has(tool.name), `duplicate ${tool.name}`);
        assertSupportedJsonSchema(tool.parameters);
        assertSupportedJsonSchema(tool.output.schema);
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
      get(name) {
        return tools.get(name);
      },
    },
    systemPrompt: {
      getSectionOrder: () => 80,
      section(s) {
        prompts.set(s.name, s);
        return () => prompts.delete(s.name);
      },
    },
    web: {},
    commands: {
      register(command) {
        assert.match(command.name, /^[a-z][a-z0-9_-]*$/);
        return () => {};
      },
    },
  };
  const features = {
    active: { search: false, reader: false },
    definitions,
    claim(kind) {
      features.active[kind] = true;
      ctx.emit("yu-extensions/web-features");
      return () => {
        features.active[kind] = false;
        ctx.emit("yu-extensions/web-features");
      };
    },
    install(kind, tool, guidance) {
      const record = { tool, guidance };
      definitions.set(kind, record);
      ctx.emit("yu-extensions/web-features");
      return () => {
        definitions.delete(kind);
        ctx.emit("yu-extensions/web-features");
      };
    },
  };
  ctx.yuExtensions = features;
  return { ctx, tools, handlers };
}
test("search native schema and reader independently take over and restore built-ins", async () => {
  const { ctx, tools, handlers } = fakeContext();
  webToolsApply(ctx, WebConfig({}));
  assert.deepEqual([...tools.keys()], ["web_search", "web_fetch"]);
  searchApply(ctx, SearchConfig({ backend: "zai" }));
  assert.ok(tools.get("web_search").parameters.properties.location);
  assert.ok(!tools.get("web_search").parameters.properties.queries);
  readerApply(ctx, ReaderConfig({}));
  assert.ok(tools.has("web_reader"));
  assert.ok(!tools.has("web_fetch"));
  assert.ok(tools.get("web_reader").parameters.properties.selector);
  const dispose = handlers.get("dispose");
  await dispose[1]();
  assert.ok(tools.has("web_search"));
  assert.ok(tools.get("web_search").parameters.properties.queries);
  assert.ok(tools.has("web_reader"));
  await dispose[2]();
  assert.ok(tools.has("web_fetch"));
  assert.ok(!tools.has("web_reader"));
  await dispose[0]();
});
test("all five search backends register their exact schema", async () => {
  for (const backend of ["google", "openai", "deepseek", "minimax", "zai"]) {
    const { ctx } = fakeContext();
    searchApply(ctx, SearchConfig({ backend }));
    const tool = ctx.yuExtensions.definitions.get("search").tool;
    assert.equal(tool.name, "web_search");
    assert.deepEqual(
      Object.keys(tool.parameters.properties).sort(),
      backend === "zai"
        ? ["content_size", "domain_filter", "location", "query", "recency"]
        : ["query"],
    );
  }
});
test("generic classifier registry finds native and OpenRouter decision models", () => {
  const ctx = {
    credentials: {
      readRecord: async () => undefined,
      resolve: async () => undefined,
    },
    get() {},
    emit() {},
  };
  for (const [provider, model] of [
    ["typesafe", "jev-latest"],
    ["openai", "gpt-6-luna"],
    ["openrouter", "microsoft/microsoft-decision-1"],
  ]) {
    const r = createClassifierRegistry(ctx, { provider, model });
    assert.equal(r.findOfType().id, model);
  }
});
test("Codex adapter passes the tier captured for the exact request", async () => {
  const { snapshotWithSpeed, installAdapterSpeed } = await import(
    "../lib/adapter-speed.js"
  );
  const { PiAiAdapter } = await import("@deepseek-ai/dsh-llm-pi-ai");
  const original = PiAiAdapter.prototype.streamWithSnapshot;
  const unpatch = installAdapterSpeed();
  assert.notEqual(PiAiAdapter.prototype.streamWithSnapshot, original);
  const stop = activateSpeedModes();
  setSpeed("tier-test", "fast");
  let passed;
  const native = {
    streamSimple(_model, _context, options) {
      passed = options;
      return "stream";
    },
  };
  const snapshot = snapshotWithSpeed(
    { models: native },
    { provider: "openai-codex", sessionId: "tier-test" },
  );
  setSpeed("tier-test", "ultrafast");
  assert.equal(
    snapshot.models.streamSimple({}, {}, { maxTokens: 25 }),
    "stream",
  );
  assert.equal(passed.serviceTier, "priority");
  assert.equal(passed.maxTokens, 25);
  assert.notEqual(snapshot.models, native);
  stop();
  unpatch();
  assert.equal(PiAiAdapter.prototype.streamWithSnapshot, original);
});
test("poller lock prevents two simultaneous owners and releases cleanly", async () => {
  const { acquirePoller } = await import("../lib/quota.js");
  const release = await acquirePoller();
  assert.equal(typeof release, "function");
  assert.equal(await acquirePoller(), undefined);
  await release();
  const second = await acquirePoller();
  assert.equal(typeof second, "function");
  await second();
});
test("Codex search does not consume the API key configured for Decisions", async () => {
  const { resolveOpenAICodexAuth } = await import("../lib/search-openai.js");
  const before = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "decision-api-key";
  try {
    const auth = await resolveOpenAICodexAuth({
      modelRegistry: {
        getProviderAuth: async () => ({
          auth: { apiKey: "codex-oauth-token" },
        }),
      },
    });
    assert.equal(auth.token, "codex-oauth-token");
  } finally {
    if (before === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = before;
  }
});
