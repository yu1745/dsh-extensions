import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
const home = mkdtempSync(join(tmpdir(), "dsh-fallback-test-"));
process.env.DSH_HOME = home;
const state = await import("../lib/fallback-state.js");
const { ModelFallback } = await import("../lib/model-fallback.js");
const a = { provider: "openai-codex", model: "top" },
  b = { provider: "other", model: "backup" },
  c = { provider: "openai-codex", model: "small" };
const put = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};
function quota(payload, now = Date.now(), extra = {}) {
  return {
    providers: {
      "openai-codex": {
        kind: "success",
        fetchedAt: now,
        checkedAt: now,
        payload,
        ...extra,
      },
    },
  };
}
function reset() {
  rmSync(join(home, "extensions", "yu1745", "model-fallback-sessions"), {
    recursive: true,
    force: true,
  });
  state.saveFallbackConfig({ enabled: true, models: [a, b, c] });
  put(state.fallbackStateFile, {});
  put(state.quotaFile, {});
}
function harness() {
  reset();
  const listeners = {},
    selection = { current: a, assembled: a },
    events = [];
  const owner = {
    selectionFor: () => selection,
    selectForNextRequest(agent, route) {
      selection.current = route;
      events.push({ ...route });
      listeners["session/event"]?.(agent.session, {
        type: "model/selection",
        data: route,
      });
    },
  };
  const ctx = {
    reflect: { provide() {} },
    effect: (f) => f(),
    on: (name, handler) => {
      listeners[name] = handler;
      return () => {};
    },
    sessionController: { agents: owner },
    typert: { register: () => () => {} },
    llm: {
      listProviders: () => [{ id: "openai-codex" }, { id: "other" }],
      listModels: async (p) =>
        p === "openai-codex"
          ? [{ id: "top" }, { id: "small" }]
          : [{ id: "backup" }],
      resolveCallConfig: async (r) => ({ ...r }),
    },
  };
  const plugin = new ModelFallback(ctx);
  const agent = {
    session: {
      id: "test",
      header: {},
      requestHeader: () => ({ config: agent.config }),
    },
    config: a,
  };
  const payload = {
    agent,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  };
  const request = async (config = selection.assembled) => {
    const result = await listeners["agent/request"](
      payload,
      async () => config,
    );
    agent.config = result;
    return result;
  };
  const fail = (failure = { code: "QUOTA", message: "Quota exhausted" }) =>
    listeners["agent/request-error"](
      { ...payload, provider: agent.config.provider, failure },
      async () => undefined,
    );
  return {
    plugin,
    ctx,
    listeners,
    selection,
    events,
    agent,
    payload,
    request,
    fail,
  };
}
test.after(() => rmSync(home, { recursive: true, force: true }));
test("configuration contains only individually selected models and preserves cross-provider ordering", () => {
  reset();
  assert.deepEqual(state.routes(state.fallbackConfig()), [a, b, c]);
  assert.throws(() =>
    state.saveFallbackConfig({ enabled: true, models: [a, a] }),
  );
  assert.throws(() => state.saveFallbackConfig({ enabled: true, models: [] }));
  state.saveFallbackConfig({ enabled: false, models: [] });
  assert.equal(state.fallbackConfig().enabled, false);
});
test("5h and weekly exhaustion waits until every empty window resets, normalizing seconds", () => {
  const now = Date.now();
  const snapshot = quota(
    {
      primary: { leftPercent: 0, resetAt: (now + 10000) / 1000 },
      secondary: { leftPercent: 0, resetAt: (now + 20000) / 1000 },
    },
    now,
  );
  const result = state.quotaStatus(a, snapshot, now);
  assert.equal(result.exhausted, true);
  assert.equal(result.until, now + 20000);
  assert.equal(state.quotaStatus(a, snapshot, now + 20001).exhausted, false);
});
test("stale snapshots, failed refreshes, and unrelated Antigravity pools cannot block models", () => {
  const now = Date.now();
  assert.equal(
    state.quotaStatus(
      a,
      quota({ primary: { leftPercent: 0 } }, now - 6 * 60000),
      now,
    ).known,
    false,
  );
  assert.equal(
    state.quotaStatus(
      a,
      quota({ primary: { leftPercent: 0 } }, now, { error: "offline" }),
      now,
    ).known,
    false,
  );
  const snap = {
    providers: {
      antigravity: {
        kind: "success",
        fetchedAt: now,
        payload: { buckets: [{ label: "Gemini 5h", leftPercent: 0 }] },
      },
    },
  };
  assert.equal(
    state.quotaStatus(
      { provider: "antigravity", model: "claude-opus" },
      snap,
      now,
    ).known,
    false,
  );
  assert.equal(
    state.quotaStatus(
      { provider: "antigravity", model: "gemini-flash" },
      snap,
      now,
    ).exhausted,
    true,
  );
});
test("only quota / balance exhaustion triggers fallback, not transient 429s, auth, context or cancellation", () => {
  for (const f of [
    { code: "QUOTA" },
    { code: "ACCOUNT_QUOTA" },
    { code: "RATE_LIMIT", message: "usage_limit_reached" },
    { code: "HTTP", message: "余额不足" },
    {
      code: "RATE_LIMIT",
      status: 429,
      message:
        '本轮运行失败429: {"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 2026-10-27 04:54:37 重置。"}',
    },
  ])
    assert.equal(state.quotaFailure(f), true);
  for (const f of [
    { code: "RATE_LIMIT", status: 429, message: "too many requests" },
    { code: "AUTH", message: "quota exceeded" },
    { code: "CONTEXT_WINDOW_EXCEEDED", message: "exceeded context" },
    { code: "ABORTED", message: "quota exceeded" },
    { code: "NETWORK", message: "timeout" },
  ])
    assert.equal(state.quotaFailure(f), false);
});
test("unknown reset uses a bounded cooldown and fresh positive quota can prove recovery", () => {
  const now = Date.now();
  const block = state.makeBlock(a, {}, {}, now);
  assert.equal(block.until, now + 300000);
  const blocks = { [state.routeKey(a)]: block };
  assert.ok(
    state.blockedRoute(
      a,
      blocks,
      quota({ primary: { leftPercent: 50 } }, now - 1000),
      now,
    ),
  );
  assert.equal(
    state.blockedRoute(
      a,
      blocks,
      quota({ primary: { leftPercent: 50 } }, now + 100),
      now + 100,
    ),
    undefined,
  );
  assert.equal(state.blockedRoute(a, blocks, {}, now + 300001), undefined);
  assert.equal(
    state.makeBlock(a, { providerRetryAfterMs: 10000 }, {}, now).until,
    now + 10000,
  );
});
test("quota failure switches and retries on native recovery, preserving durable request attribution", async () => {
  const h = harness();
  assert.deepEqual(await h.request(), a);
  assert.deepEqual(await h.fail(), { kind: "retry" });
  assert.deepEqual(h.selection.current, b);
  assert.deepEqual(h.selection.assembled, b);
  const next = await h.request();
  assert.deepEqual(next, b);
  assert.deepEqual(h.agent.config, b);
  assert.deepEqual(h.events, [b]);
});
test("Chinese five-hour quota 429 advances the configured model queue", async () => {
  const h = harness();
  await h.request();
  assert.deepEqual(
    await h.fail({
      code: "RATE_LIMIT",
      status: 429,
      message:
        '{"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 2026-10-27 04:54:37 重置。"}',
    }),
    { kind: "retry" },
  );
  assert.deepEqual(h.selection.current, b);
  assert.deepEqual(await h.request(), b);
});
test("all candidates exhausted stops fallback; a failure chain never cycles to already tried models", async () => {
  const h = harness();
  await h.request();
  await h.fail();
  await h.request();
  assert.deepEqual(await h.fail(), { kind: "retry" });
  await h.request();
  assert.equal(await h.fail(), undefined);
  assert.equal(h.events.length, 2);
  assert.equal(h.events[1].model, "small");
  // Even a fresh positive poll cannot repeat a model in this same failed step.
  put(state.quotaFile, quota({ primary: { leftPercent: 90 } }, Date.now() + 1));
  assert.equal(await h.fail(), undefined);
});
test("network retry stays on its model and does not advance the priority cursor", async () => {
  const h = harness();
  await h.request();
  assert.equal(
    await h.fail({ code: "NETWORK", message: "timeout" }),
    undefined,
  );
  assert.deepEqual(await h.request(), a);
  assert.equal(h.events.length, 0);
});
test("recovered high-priority model is restored at the next prompt boundary", async () => {
  const h = harness();
  await h.request();
  await h.fail();
  await h.request();
  put(state.fallbackStateFile, {});
  h.payload.step = 2;
  const result = await h.listeners["system-prompt/assemble"](
    {},
    { agent: h.agent, signal: h.payload.signal },
    async () => ({ variables: h.selection.current }),
  );
  assert.deepEqual(result.variables, a);
  assert.deepEqual(h.selection.current, a);
  assert.deepEqual(await h.request(), a);
});
test("known exhausted account skips its other models; removed catalog entries are skipped", async () => {
  const h = harness();
  put(
    state.quotaFile,
    quota({
      primary: { leftPercent: 0, resetAt: (Date.now() + 60000) / 1000 },
    }),
  );
  assert.deepEqual(await h.plugin.choose(a), b);
  h.ctx.llm.listModels = async (p) =>
    p === "other" ? [] : [{ id: "top" }, { id: "small" }];
  assert.equal(await h.plugin.choose(a), undefined);
});
test("disabled chains, subagents and canceled requests remain unchanged", async () => {
  const h = harness();
  state.saveFallbackConfig({ enabled: false, models: [a, b] });
  assert.equal(await h.plugin.choose(a), undefined);
  state.saveFallbackConfig({ enabled: true, models: [a, b] });
  h.agent.session.header.parentSession = "parent";
  assert.equal(await h.fail(), undefined);
  assert.equal(h.events.length, 0);
  delete h.agent.session.header.parentSession;
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(() => h.plugin.choose(a, abort.signal));
  h.payload.signal = abort.signal;
  assert.equal(await h.fail(), undefined);
});
test("cross-provider retry clears incompatible effort and token defaults, and status is JSON-safe", async () => {
  const h = harness();
  await h.request({ ...a, reasoningEffort: "xhigh", maxTokens: 99999 });
  await h.fail();
  const next = await h.request({
    ...a,
    reasoningEffort: "xhigh",
    maxTokens: 99999,
  });
  assert.deepEqual(next, b);
  assert.doesNotThrow(() => JSON.stringify(h.plugin.status()));
  assert.equal(
    h.plugin.status().models.find((r) => r.model === a.model).blocked.reason,
    "额度耗尽",
  );
});

test("manually selected lower-ranked model takes precedence over the configured first model", async () => {
  const h = harness();
  h.selection.current = b;
  h.selection.assembled = b;
  h.agent.config = b;
  const result = await h.listeners["system-prompt/assemble"](
    {},
    { agent: h.agent, signal: h.payload.signal },
    async () => ({ variables: h.selection.current }),
  );
  assert.deepEqual(result.variables, b);
  assert.deepEqual(await h.request(), b);
  assert.equal(h.events.length, 0);
});
test("quota reset and provider delay are both respected", () => {
  const now = Date.now();
  const snap = quota(
    { primary: { leftPercent: 0, resetAt: (now + 60000) / 1000 } },
    now,
  );
  assert.equal(
    state.makeBlock(a, { providerRetryAfterMs: 1000 }, snap, now).until,
    now + 60000,
  );
});

test("a manually selected model outside the queue never triggers fallback or blocking", async () => {
  const h = harness(),
    manual = { provider: "other", model: "manual" };
  h.ctx.llm.listModels = async (p) =>
    p === "other"
      ? [{ id: "manual" }, { id: "backup" }]
      : [{ id: "top" }, { id: "small" }];
  h.selection.current = manual;
  h.selection.assembled = manual;
  h.agent.config = manual;
  assert.equal(await h.plugin.choose(manual), undefined);
  assert.deepEqual(await h.request(), manual);
  assert.equal(await h.fail(), undefined);
  assert.deepEqual(h.selection.current, manual);
  assert.deepEqual(h.events, []);
  assert.deepEqual(
    h.plugin.status().models.map((model) => model.blocked),
    [null, null, null],
  );
  h.payload.step++;
  await h.listeners["system-prompt/assemble"](
    {},
    { agent: h.agent, signal: h.payload.signal },
    async () => ({}),
  );
  assert.deepEqual(h.selection.current, manual);
  assert.deepEqual(await h.request(), manual);
  assert.equal(await h.fail(), undefined);
});
test("manually switching away from an automatic backup disables fallback for an unlisted model", async () => {
  const h = harness(),
    manual = { provider: "other", model: "manual" };
  await h.request();
  assert.deepEqual(await h.fail(), { kind: "retry" });
  h.selection.current = manual;
  h.selection.assembled = manual;
  h.agent.config = manual;
  h.listeners["session/event"](h.agent.session, {
    type: "model/selection",
    data: manual,
  });
  h.payload.step++;
  await h.listeners["system-prompt/assemble"](
    {},
    { agent: h.agent, signal: h.payload.signal },
    async () => ({}),
  );
  assert.deepEqual(await h.request(), manual);
  assert.equal(await h.fail(), undefined);
  assert.deepEqual(h.selection.current, manual);
  assert.deepEqual(h.events, [b]);
});
test("an automatic backup never replaces the preferred model, including after a plugin restart", async () => {
  const h = harness();
  await h.request();
  await h.fail();
  await h.request();
  assert.deepEqual(h.selection.current, b);
  new ModelFallback(h.ctx);
  put(state.fallbackStateFile, {});
  h.payload.step++;
  await h.listeners["system-prompt/assemble"](
    {},
    { agent: h.agent, signal: h.payload.signal },
    async () => ({}),
  );
  assert.deepEqual(h.selection.current, a);
});
test("manually selecting the automatic backup promotes it to the preferred head", async () => {
  const h = harness();
  await h.request();
  await h.fail();
  await h.request();
  h.listeners["session/event"](h.agent.session, {
    type: "model/selection",
    data: b,
  });
  put(state.fallbackStateFile, {});
  h.payload.step++;
  await h.listeners["system-prompt/assemble"](
    {},
    { agent: h.agent, signal: h.payload.signal },
    async () => ({}),
  );
  assert.deepEqual(h.selection.current, b);
  assert.deepEqual(await h.request(), b);
});
test("implicit preferred model is deduplicated when it also appears in the backup order", async () => {
  const h = harness();
  assert.deepEqual(await h.plugin.choose(b), b);
  const excluded = new Set([state.routeKey(b)]);
  assert.deepEqual(await h.plugin.choose(b, undefined, excluded), a);
  excluded.add(state.routeKey(a));
  assert.deepEqual(await h.plugin.choose(b, undefined, excluded), c);
});
test("the preferred model retains its explicitly selected reasoning effort", async () => {
  const h = harness(),
    selected = { ...a, reasoningEffort: "high" };
  h.ctx.llm.resolveCallConfig = async (route) => ({ ...route });
  assert.deepEqual(await h.plugin.choose(selected), selected);
});
