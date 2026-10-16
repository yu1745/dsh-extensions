import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const home = mkdtempSync(join(tmpdir(), "dsh-providers-test-"));
process.env.DSH_HOME = home;
const { parseCodexCredits, parseCodexUsage } = await import(
  "../lib/codex-quota.js"
);
const { createCodebuddyProvider } = await import(
  "../lib/codebuddy-provider.js"
);
const { createAntigravityProvider } = await import(
  "../lib/antigravity-provider.js"
);
const { profileFor, credentialStore } = await import("../lib/providers.js");
const { PiAiAdapter } = await import("@deepseek-ai/dsh-llm-pi-ai");
const { createModels } = await import("@earendil-works/pi-ai");
test.after(() => rmSync(home, { recursive: true, force: true }));
test("Codex credits preserve exact balance independently of usage percentage", () => {
  const payload = parseCodexUsage({
    rate_limit: { primary_window: { used_percent: 60 } },
    credits: {
      has_credits: true,
      unlimited: false,
      balance: "62335.6860000000",
    },
  }).payload;
  assert.equal(payload.primary.leftPercent, 40);
  assert.equal(payload.credits.balance, 62335.686);
  assert.equal(parseCodexCredits({ balance: "0" }).balance, 0);
  for (const balance of [null, "", " ", "bad", Infinity])
    assert.equal(parseCodexCredits({ balance }).balance, undefined);
  assert.equal(parseCodexCredits({ unlimited: true }).unlimited, true);
  assert.equal(parseCodexCredits(null), undefined);
});
test("provider routes expose native DSH model and reasoning metadata", async () => {
  const providers = [
    createAntigravityProvider(),
    await createCodebuddyProvider({
      readCredential: async () => undefined,
      refreshCredential: async () => {
        throw Error("unexpected");
      },
    }),
  ];
  const profiles = new Map(providers.map((p) => [p.id, profileFor(p)]));
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => undefined,
    auth: {
      credentials: {
        read: async () => undefined,
        list: async () => [],
        modify: async () => undefined,
        delete: async () => {},
      },
      authContext: {},
    },
  });
  const ag = await adapter.listModels("antigravity");
  assert(ag.some((m) => m.id === "gemini-3.8-flash"));
  const collection = createModels();
  collection.setProvider(providers[0]);
  const agModel = collection.getModel("antigravity", "gemini-3.8-flash");
  assert.equal(agModel.provider, "antigravity");
  assert(agModel.api);
  const cb = await adapter.resolveModel("codebuddy", "deepseek-v4.1-flash");
  assert.deepEqual(
    cb.reasoning.efforts.map((e) => e.id),
    ["low", "high", "max"],
  );
});
test("credential store updates only owned grants and preserves the lock boundary", async () => {
  const records = new Map();
  let locked = false;
  const ctx = {
    credentials: {
      readRecord: async (k) => records.get(k),
      modifyRecord: async (k, fn) => {
        assert(!locked);
        locked = true;
        try {
          const next = await fn(records.get(k));
          if (next === undefined) records.delete(k);
          else records.set(k, next);
          return next;
        } finally {
          locked = false;
        }
      },
      deleteRecord: async (k) => records.delete(k),
    },
  };
  const store = credentialStore(ctx);
  await store.modify("antigravity", async (c) => {
    assert(locked);
    assert.equal(c, undefined);
    return { type: "oauth", access: "old", refresh: "r", expires: 0 };
  });
  await store.modify("antigravity", async (c) => ({ ...c, access: "new" }));
  assert.equal((await store.read("antigravity")).access, "new");
  assert.equal(records.get("llm-pi-ai/antigravity").kind, "grant");
  await assert.rejects(() => store.read("openai-codex"));
});
test("CodeBuddy keeps DSH prompt and tools and retries one 401 with refreshed credentials", async () => {
  const requests = [];
  let count = 0;
  let refreshes = 0;
  const provider = await createCodebuddyProvider({
    readCredential: async () =>
      count === 0 ? undefined : { access: "old", userId: "test" },
    refreshCredential: async () => {
      refreshes++;
      return { access: "new", userId: "test" };
    },
    fetch: async (url, init) => {
      requests.push({
        body: JSON.parse(init.body),
        headers: init.headers,
        signal: init.signal,
      });
      if (requests.length === 1) return new Response("", { status: 401 });
      return new Response(
        "data: " +
          JSON.stringify({
            id: "test",
            object: "chat.completion.chunk",
            created: 1,
            model: "deepseek-v4.1-flash",
            choices: [
              { index: 0, delta: { content: "OK" }, finish_reason: null },
            ],
          }) +
          "\n\ndata: " +
          JSON.stringify({
            id: "test",
            object: "chat.completion.chunk",
            created: 1,
            model: "deepseek-v4.1-flash",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          }) +
          "\n\ndata: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  count = 1;
  const models = createModels({
    credentials: {
      read: async () => ({
        type: "oauth",
        access: "old",
        refresh: "r",
        expires: Date.now() + 3600000,
      }),
      list: async () => [],
      modify: async () => {
        throw Error("unexpected refresh");
      },
      delete: async () => {},
    },
  });
  models.setProvider(provider);
  const model = models.getModel("codebuddy", "deepseek-v4.1-flash");
  const signal = new AbortController().signal;
  const stream = models.streamSimple(
    model,
    {
      systemPrompt: "DSH original system",
      messages: [{ role: "user", content: "test", timestamp: Date.now() }],
      tools: [
        {
          name: "read_file",
          description: "Read DSH file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
    },
    {
      apiKey: "old",
      reasoning: "low",
      sessionId: "dsh-session-one",
      signal,
      maxTokens: 64,
    },
  );
  const events = [];
  for await (const event of stream) events.push(event);
  assert.equal(events.at(-1).type, "done", JSON.stringify(events.at(-1)));
  assert.equal(refreshes, 1);
  assert.equal(requests.length, 2);
  assert(
    requests[0].body.messages.some((m) => m.content === "DSH original system"),
  );
  assert.deepEqual(
    requests[0].body.tools.map((t) => t.function.name),
    ["read_file"],
  );
  assert.equal(requests[0].body.max_tokens, 64);
  assert.equal(requests[0].headers["x-conversation-id"], "dsh-session-one");
  assert.equal(requests[1].headers.authorization, "Bearer new");
  assert(requests[0].signal);
});
