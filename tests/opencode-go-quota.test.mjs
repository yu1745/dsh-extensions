import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  fetchOpenCodeGo,
  parseOpenCodeGoUsage,
  OPENCODE_GO_USAGE_URL,
} from "../lib/opencode-go-quota.js";
import { pointsFromPayload } from "../lib/quota.js";

const now = Date.UTC(2026, 10, 4);
const usage = {
  useBalance: true,
  rollingUsage: { status: "ok", usagePercent: 25, resetInSec: 3600 },
  weeklyUsage: { status: "rate-limited", usagePercent: 100, resetInSec: 86400 },
  monthlyUsage: { status: "ok", usagePercent: 0, resetInSec: 100000 },
};
test("Go usage maps to remaining buckets and history with ISO reset times", () => {
  const result = parseOpenCodeGoUsage(usage, now);
  assert.equal(result.kind, "success");
  assert.equal(result.payload.useBalance, true);
  assert.deepEqual(
    result.payload.buckets.map((b) => [b.label, b.leftPercent]),
    [
      ["5h", 75],
      ["周", 0],
      ["月", 100],
    ],
  );
  assert.equal(
    result.payload.buckets[0].resetTime,
    new Date(now + 3600000).toISOString(),
  );
  assert.deepEqual(pointsFromPayload(result.payload)[0], {
    name: "5h",
    value: 75,
    unit: "%",
    resetAt: new Date(now + 3600000).toISOString(),
  });
});
test("Go current API nested windows include absolute resets and do not invent balance settings", () => {
  const result = parseOpenCodeGoUsage(
    {
      usage: {
        rolling: {
          status: "ok",
          percent: 6,
          resetsAt: "2026-11-04T05:10:35.000Z",
        },
        weekly: {
          status: "ok",
          percent: 10,
          resetsAt: "2026-11-09T00:00:00.000Z",
        },
        monthly: {
          status: "ok",
          percent: 5,
          resetsAt: "2026-12-03T08:55:42.000Z",
        },
      },
    },
    now,
  );
  assert.equal(result.kind, "success");
  assert.deepEqual(
    result.payload.buckets.map((b) => b.leftPercent),
    [94, 90, 95],
  );
  assert.equal(result.payload.buckets[0].resetTime, "2026-11-04T05:10:35.000Z");
  assert.equal(result.payload.useBalance, undefined);
});
test("Go parser rejects errors and malformed data, preserves zero and clamps percentages", () => {
  for (const body of [
    null,
    {},
    "<html>",
    { type: "error" },
    { rollingUsage: { status: "ok", usagePercent: "25" } },
    { rollingUsage: { status: "ok", usagePercent: NaN } },
  ])
    assert.equal(parseOpenCodeGoUsage(body, now).kind, "unavailable");
  const result = parseOpenCodeGoUsage(
    { rollingUsage: { status: "ok", usagePercent: 150, resetInSec: -1 } },
    now,
  );
  assert.equal(result.payload.buckets[0].leftPercent, 0);
  assert.equal(result.payload.buckets[0].resetTime, undefined);
  assert.equal(result.payload.useBalance, undefined);
});
test("Go fetch uses its official endpoint, safe errors, and no redirects", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, OPENCODE_GO_USAGE_URL);
      assert.equal(options.headers.Authorization, "Bearer go-test-key");
      assert.equal(options.redirect, "error");
      return Response.json(usage);
    };
    assert.equal((await fetchOpenCodeGo("go-test-key")).kind, "success");
    for (const [status, kind] of [
      [401, "auth_error"],
      [429, "rate_limited"],
      [500, "unavailable"],
    ]) {
      globalThis.fetch = async () => new Response("error", { status });
      assert.equal((await fetchOpenCodeGo("go-test-key")).kind, kind);
    }
    globalThis.fetch = async () => new Response("denied", { status: 403 });
    await assert.rejects(
      fetchOpenCodeGo("go-test-key"),
      /没有 OpenCode Go 订阅权限/,
    );
    globalThis.fetch = async () => new Response("<html>not usage</html>");
    assert.equal((await fetchOpenCodeGo("go-test-key")).kind, "unavailable");
    globalThis.fetch = async () => {
      throw new Error("go-test-key");
    };
    assert.equal((await fetchOpenCodeGo("go-test-key")).kind, "unavailable");
  } finally {
    globalThis.fetch = original;
  }
});
test("Go quota and UI are registered under opencode-go, not opencode", () => {
  const quota = readFileSync(
    new URL("../src/quota.ts", import.meta.url),
    "utf8",
  );
  const client = readFileSync(
    new URL("../src/client.tsx", import.meta.url),
    "utf8",
  );
  const auth = readFileSync(new URL("../src/auth.ts", import.meta.url), "utf8");
  assert.match(quota, /"opencode-go": fetchOpenCodeGo/);
  assert.match(client, /"opencode-go": "OpenCode Go"/);
  assert.match(
    auth,
    /"opencode-go": \["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"\]/,
  );
  assert.doesNotMatch(quota, /"opencode": fetchOpenCodeGo/);
});
