import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const home = mkdtempSync(join(tmpdir(), "dsh-extensions-tests-"));
process.env.DSH_HOME = home;
const {
  deepseekRates,
  priceUsage,
  priceBreakdown,
  aggregateCosts,
  normalizeCost,
  billingCurrency,
  costRows,
  installCosts,
} = await import("../lib/costs.js");
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
test("DeepSeek uses exact USD and CNY cards with their own peak boundaries", () => {
  const at = (day, h, minute = 0) => Date.UTC(2026, 9, day, h, minute);
  // USD card peaks in UTC.
  assert.equal(deepseekRates("deepseek-flash", at(16, 0)).input, 0.15);
  assert.equal(deepseekRates("deepseek-flash", at(16, 1)).input, 0.3);
  assert.equal(deepseekRates("deepseek-flash", at(16, 4)).input, 0.15);
  assert.equal(deepseekRates("deepseek-flash", at(16, 6)).cacheRead, 0.006);
  assert.equal(deepseekRates("deepseek-flash", at(16, 10)).output, 0.6);
  assert.equal(deepseekRates("deepseek-v4-pro", at(16, 2)).input, 1.32);
  assert.equal(deepseekRates("deepseek-v4-pro", at(17, 2)).output, 1.98);
  assert.equal(deepseekRates("unknown", at(16, 2)), undefined);

  // CNY card peaks in Beijing time: 09:00-12:00 and 14:00-18:00.
  assert.deepEqual(deepseekRates("deepseek-flash", at(16, 0), "CNY"), {
    input: 1,
    output: 4,
    cacheRead: 0.02,
    cacheWrite: 0,
  });
  assert.equal(deepseekRates("deepseek-flash", at(16, 1), "CNY").input, 2);
  assert.equal(deepseekRates("deepseek-flash", at(16, 4, 30), "CNY").input, 1);
  assert.equal(deepseekRates("deepseek-flash", at(16, 6, 30), "CNY").input, 2);
  assert.equal(deepseekRates("deepseek-flash", at(16, 10), "CNY").output, 4);
  assert.equal(deepseekRates("deepseek-v4-pro", at(16, 2), "CNY").input, 9);
  assert.equal(deepseekRates("deepseek-v4-pro", at(16, 2), "CNY").output, 27);
  assert.equal(
    deepseekRates("deepseek-v4-pro", at(16, 2), "CNY").cacheRead,
    0.3,
  );
  // Saturday 10:00 Beijing is off-peak even though the UTC clock says 02:00.
  assert.equal(deepseekRates("deepseek-flash", at(17, 2), "CNY").input, 1);
  // Sunday 16:00 UTC is Monday 00:00 Beijing; Monday 01:00 UTC is 09:00.
  assert.equal(deepseekRates("deepseek-flash", at(18, 16), "CNY").input, 1);
  assert.equal(deepseekRates("deepseek-flash", at(19, 1), "CNY").input, 2);

  const usage = { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6 };
  assert.equal(billingCurrency("deepseek-official"), "CNY");
  assert.equal(billingCurrency("openai-codex"), "USD");
  assert.equal(
    priceUsage("deepseek-official", "deepseek-flash", usage, at(16, 1)),
    10.04,
  );
  assert.equal(
    priceUsage(
      "deepseek-official",
      "deepseek-flash",
      usage,
      at(16, 1),
      undefined,
      "USD",
    ),
    1.506,
  );
  assert.equal(
    priceUsage("deepseek-official", "deepseek-flash", usage, at(16, 0)),
    5.02,
  );
  assert.deepEqual(
    priceBreakdown("deepseek-official", "deepseek-flash", usage, at(16, 0))
      .parts,
    { cacheRead: 0.02, input: 1, output: 4, cacheWrite: 0 },
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
test("mixed currencies stay in separate buckets and legacy DeepSeek rows use the CNY card", () => {
  const result = Object.fromEntries(
    aggregateCosts(
      [
        {
          sessionId: "p",
          amount: 0.5,
          currency: "CNY",
          parts: { cacheRead: 0.2, input: 0.1, output: 0.2, cacheWrite: 0 },
        },
        {
          sessionId: "c",
          amount: 0.25,
          currency: "USD",
          parts: { cacheRead: 0.05, input: 0.1, output: 0.1, cacheWrite: 0 },
        },
        {
          sessionId: "c",
          amount: 0.1,
          currency: "CNY",
          parts: { cacheRead: 0.04, input: 0.02, output: 0.04, cacheWrite: 0 },
        },
      ],
      { c: "p" },
    ).map((row) => [row.sessionId, row]),
  );
  assert.deepEqual(result.p.amounts, { CNY: 0.5 });
  assert.deepEqual(result.p.totalAmounts, { CNY: 0.6, USD: 0.25 });
  assert.equal(result.p.usd, 0);
  assert.equal(result.p.totalUsd, 0.25);
  assert.deepEqual(result.c.totalAmounts, { CNY: 0.1, USD: 0.25 });
  const near = (actual, expected) => Math.abs(actual - expected) < 1e-12;
  assert.ok(near(result.p.totalParts.CNY.cacheRead, 0.24));
  assert.ok(near(result.p.totalParts.CNY.input, 0.12));
  assert.ok(near(result.p.totalParts.CNY.output, 0.24));
  assert.ok(near(result.p.totalParts.USD.cacheRead, 0.05));
  assert.ok(near(result.p.totalParts.USD.input, 0.1));
  assert.ok(near(result.c.totalParts.CNY.input, 0.02));

  // Legacy rows have no currency. DeepSeek official is re-priced with the
  // exact CNY card at the request time; the stored USD number is not reused
  // and no exchange rate is involved.
  const usage = { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0 };
  const legacy = aggregateCosts([
    {
      sessionId: "d",
      provider: "deepseek-official",
      model: "deepseek-flash",
      startedAt: Date.UTC(2026, 9, 16, 0),
      usage,
      usd: 0.15,
    },
  ])[0];
  assert.deepEqual(legacy.amounts, { CNY: 1 });
  assert.equal(legacy.usd, 0);
  assert.deepEqual(legacy.parts.CNY, {
    cacheRead: 0,
    input: 1,
    output: 0,
    cacheWrite: 0,
  });

  const amountOnly = aggregateCosts([
    {
      sessionId: "n",
      provider: "deepseek-official",
      model: "deepseek-flash",
      startedAt: Date.UTC(2026, 9, 16, 0),
      usage,
      amount: 1,
      currency: "CNY",
    },
  ])[0];
  assert.deepEqual(amountOnly.parts.CNY, {
    cacheRead: 0,
    input: 1,
    output: 0,
    cacheWrite: 0,
  });

  const usdLegacy = aggregateCosts([
    { sessionId: "u", provider: "openai-codex", usd: 0.5 },
  ])[0];
  assert.deepEqual(usdLegacy.amounts, { USD: 0.5 });
  assert.deepEqual(usdLegacy.parts, {});
});
test("GPT-6.1 Terra uses the official Codex Standard API card and long-context tier", () => {
  const at = Date.UTC(2026, 9, 27);
  assert.deepEqual(
    priceBreakdown(
      "openai-codex",
      "gpt-6.1-terra",
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      },
      at,
    )?.parts,
    { input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 },
  );
  assert.deepEqual(
    priceBreakdown(
      "openai-codex",
      "gpt-6.1-terra",
      {
        inputTokens: 100_000,
        outputTokens: 100_000,
        cacheReadTokens: 100_000,
        cacheWriteTokens: 50_000,
      },
      at,
    )?.parts,
    { input: 0.1, output: 0.5, cacheRead: 0.005, cacheWrite: 0.0625 },
  );
  assert.equal(
    priceUsage(
      "openai-codex",
      "gpt-6-sol",
      { inputTokens: 100_000, outputTokens: 100_000 },
      at,
    ),
    1.2,
  );
});
test("llm ledger rows store the provider billing currency", async () => {
  const handlers = {};
  installCosts(
    {
      on: (name, handler) => {
        handlers[name] = handler;
      },
    },
    {},
  );
  const stream = handlers["llm/stream"];
  const realNow = Date.now;
  Date.now = () => Date.UTC(2026, 9, 16, 0);
  try {
    const read = async (sessionId, provider, model) => {
      for await (const chunk of stream(
        { sessionId, provider, model },
        async function* () {
          yield {
            type: "usage",
            usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0 },
          };
        },
      ))
        void chunk;
    };
    await read("ledger-deepseek", "deepseek-official", "deepseek-flash");
    await read("ledger-codex", "openai-codex", "gpt-5.6-luna");
  } finally {
    Date.now = realNow;
  }
  const rows = costRows();
  const deepseek = rows.find((row) => row.sessionId === "ledger-deepseek");
  assert.equal(deepseek.currency, "CNY");
  assert.equal(deepseek.amount, 0.001);
  assert.ok(Math.abs(deepseek.parts.input - 0.001) < 1e-15);
  assert.equal(deepseek.parts.cacheRead, 0);
  const codex = rows.find((row) => row.sessionId === "ledger-codex");
  assert.equal(codex.currency, "USD");
  assert.equal(codex.amount, 0.0002);
  assert.ok(Math.abs(codex.parts.input - 0.0002) < 1e-15);
});
test("Codex Fast requests use double Standard API rates, including historical unknown rows", async () => {
  const handlers = {};
  installCosts({ on: (name, handler) => (handlers[name] = handler) });
  const usage = {
    inputTokens: 100_000,
    outputTokens: 100_000,
    cacheReadTokens: 100_000,
    cacheWriteTokens: 0,
  };
  const run = async (sessionId, model) => {
    for await (const chunk of handlers["llm/stream"](
      { sessionId, provider: "openai-codex", model },
      async function* () {
        yield { type: "usage", usage };
      },
    ))
      void chunk;
    return costRows().find((row) => row.sessionId === sessionId);
  };
  setSpeed("sol-fast", "fast");
  const fast = await run("sol-fast", "gpt-6-sol");
  assert.equal(fast.requestedSpeed, "fast");
  assert.deepEqual(fast.parts, {
    cacheRead: 0.04,
    input: 0.4,
    output: 2,
    cacheWrite: 0,
  });
  assert.equal(fast.amount, 2.44);
  const historical = { ...fast, amount: null, parts: null };
  assert.deepEqual(normalizeCost(historical), {
    amount: 2.44,
    currency: "USD",
    parts: fast.parts,
  });
  setSpeed("terra-fast", "fast");
  assert.equal((await run("terra-fast", "gpt-6.1-terra")).amount, 1.21);
  for (const [sessionId, model, expected] of [
    ["sol61-fast", "gpt-6.1-sol", 2.42],
    ["astra-fast", "gpt-6-astra", 12.2],
    ["luna-fast", "gpt-6-luna", 0.122],
  ]) {
    setSpeed(sessionId, "fast");
    const row = await run(sessionId, model);
    assert.ok(Math.abs(row.amount - expected) < 1e-12, model);
    assert.ok(
      Math.abs(
        normalizeCost({ ...row, amount: null, parts: null }).amount - expected,
      ) < 1e-12,
      `${model} historical Fast row`,
    );
  }
  setSpeed("sol-ultrafast", "ultrafast");
  assert.equal((await run("sol-ultrafast", "gpt-6-sol")).amount, null);
  assert.equal(
    normalizeCost({ ...historical, requestedSpeed: "ultrafast" }).amount,
    null,
  );
  setSpeed("unknown-fast", "fast");
  assert.equal((await run("unknown-fast", "gpt-5.6-luna")).amount, null);
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
    agents: { list: () => [] },
    credentials: {
      readRecord: async () => undefined,
      resolve: async () => undefined,
    },
    get(n) {
      return this[n];
    },
    effect(factory) {
      const dispose = factory();
      return () => dispose?.();
    },
    reflect: { provide() {} },
    typert: { register: () => () => {} },
    inject(deps, callback) {
      if (deps.every((name) => this.get(name) !== undefined)) callback(this);
      return () => {};
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

test("Fast dock API shares command state and sets an explicit session mode", async () => {
  const { Quota } = await import("../lib/quota.js");
  const api = Object.create(Quota.prototype);
  setSpeed("dock-session", "ultrafast");
  assert.deepEqual(api.speed("dock-session"), { mode: "ultrafast" });
  assert.deepEqual(api.setFast("dock-session", false), { mode: "standard" });
  assert.equal(speedOf("dock-session"), "standard");
  assert.deepEqual(api.setFast("dock-session", true), { mode: "fast" });
  assert.deepEqual(api.setFast("dock-session", true), { mode: "fast" });
  setSpeed("dock-session", "standard");
  assert.deepEqual(api.speed("dock-session"), { mode: "standard" });
});
test("search overrides stay explicit, follow the global default, and clear cleanly", async () => {
  const search = await import("../lib/search-context.js");
  const { settings, updateSettings } = await import("../lib/state.js");
  const before = settings().webSearchBackend;
  updateSettings({ webSearchBackend: "google" });
  try {
    // Older releases wrote one override per attached session without a flag.
    // Such a record must keep following the global default, not pin "zai".
    const legacy = join(
      home,
      "extensions",
      "yu1745",
      "search-backends",
      "legacy-session.json",
    );
    mkdirSync(join(legacy, ".."), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ backend: "zai" }));
    assert.equal(search.explicitSearchBackend("legacy-session"), undefined);
    assert.equal(search.searchBackendFor("legacy-session"), "google");
    assert.deepEqual(search.searchOverrides(), []);

    search.saveSearchBackend("pinned-session", "deepseek");
    assert.equal(search.explicitSearchBackend("pinned-session"), "deepseek");
    assert.equal(search.searchBackendFor("pinned-session"), "deepseek");
    assert.deepEqual(search.searchOverrides(), [
      { sessionId: "pinned-session", backend: "deepseek" },
    ]);

    // The global default moves sessions that never opted in, and only those.
    updateSettings({ webSearchBackend: "minimax" });
    assert.equal(search.searchBackendFor("legacy-session"), "minimax");
    assert.equal(search.searchBackendFor("pinned-session"), "deepseek");

    search.clearSearchOverrides();
    assert.deepEqual(search.searchOverrides(), []);
    assert.equal(search.searchBackendFor("pinned-session"), "minimax");
  } finally {
    updateSettings({ webSearchBackend: before ?? "google" });
  }
});
test("settings face reports the default, the backends and explicit overrides", async () => {
  const { WebSearch } = await import("../lib/web-search.js");
  const search = await import("../lib/search-context.js");
  const { settings, updateSettings } = await import("../lib/state.js");
  const before = settings().webSearchBackend;
  const registered = [];
  const ctx = {
    reflect: { provide() {} },
    effect: (f) => f(),
    typert: {
      register(info) {
        registered.push(info);
        return () => {};
      },
    },
  };
  try {
    search.clearSearchOverrides();
    updateSettings({ webSearchBackend: "openai" });
    const service = new WebSearch(ctx, () => {});
    assert.equal(service.name, "yuWebSearch");
    assert.equal(registered[0].package, "@yu1745/dsh-extensions/web-search");
    assert.equal(registered[0].invocations.length, 3);
    const initial = service.settings();
    assert.equal(initial.defaultBackend, "openai");
    assert.deepEqual(initial.backends, [
      "google",
      "openai",
      "deepseek",
      "minimax",
      "zai",
    ]);
    assert.deepEqual(initial.overrides, []);

    search.saveSearchBackend("other-session", "zai");
    assert.deepEqual(service.setDefault("deepseek").overrides, [
      { sessionId: "other-session", backend: "zai" },
    ]);
    assert.equal(search.searchBackendFor("other-session"), "zai");
    assert.equal(search.searchBackendFor("free-session"), "deepseek");
    assert.deepEqual(service.clearOverrides().overrides, []);
    assert.equal(search.searchBackendFor("other-session"), "deepseek");
    assert.throws(() => service.setDefault("nope"), /Unknown backend/);
  } finally {
    search.clearSearchOverrides();
    updateSettings({ webSearchBackend: before ?? "google" });
  }
});
