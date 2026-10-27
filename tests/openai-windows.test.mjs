import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "@deepseek-ai/dsh-session";
import {
  createUserMessage,
  createSystemMessage,
  createAssistantMessage,
  createToolResultMessage,
} from "@deepseek-ai/dsh-llm";
const estimateMessage = (message) =>
  Math.ceil(JSON.stringify(message).length / 4);
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import Windows, { snapshotWithWindows } from "../lib/openai-windows.js";
import Engine from "../lib/openai-window-compaction.js";
import {
  WINDOW_GUIDANCE,
  initialWindow,
  foldWindow,
  checkpointReady,
  currentRoute,
  isOpenaiRoute,
  notePath,
  parseMarker,
} from "../lib/openai-window-state.js";
import { windowTools } from "../lib/openai-window-protocol.js";
const signal = new AbortController().signal;
function harness(provider = "openai-codex") {
  const session = Session.create("window-test");
  let state = initialWindow(session.header);
  let scanned = 0;
  const events = {},
    defs = new Map(),
    sections = [],
    contexts = [],
    cleanup = [];
  const ctx = {
    reflect: { provide() {} },
    on: (name, fn) => {
      (events[name] ??= []).push(fn);
      return () => {};
    },
    get: () => undefined,
    logger: { info() {}, warn() {} },
    agents: {},
    sessionProjections: {
      register: () => () => {},
      stateOf: () => {
        for (const e of session.snapshotEvents(scanned)) {
          state = foldWindow(state, e);
        }
        scanned = session.seq;
        return state;
      },
    },
    tools: {},
    systemPrompt: {},
    llm: {
      resolveModelInfo: async () => ({
        context: { contextWindow: 100000 },
        defaultMaxTokens: 1000,
      }),
    },
    sessions: { flush: async () => {} },
    tokenMeter: {
      estimateMessage,
      measure: () => {
        const nodes = session.surface.nodes.map((seq) => ({
          seq,
          tokens: estimateMessage(
            session.deriveEventMessage(session.eventAt(seq)),
          ),
          heuristicTokens: estimateMessage(
            session.deriveEventMessage(session.eventAt(seq)),
          ),
        }));
        return { nodes, totalTokens: nodes.reduce((n, x) => n + x.tokens, 0) };
      },
    },
  };
  const owner = new Windows(ctx, {
    enabled: true,
    thresholdRatio: 0.8,
    headroomTokens: 32768,
    reminderTokens: 16384,
  });
  ctx.yuOpenaiWindows = owner;
  const scope = {
    get: () => undefined,
    effect: (fn) => {
      const stop = fn();
      cleanup.push(stop);
      return stop;
    },
    tools: {
      presentAs: () => () => {},
      register: (d) => {
        defs.set(d.name, d);
        return () => defs.delete(d.name);
      },
    },
    systemPrompt: {
      section: (s) => {
        sections.push(s);
        return () => {};
      },
      context: (s) => {
        contexts.push(s);
        return () => {};
      },
    },
  };
  const agent = {
    id: session.id,
    session,
    ctx: scope,
    options: {
      provider,
      model: provider === "openai-codex" ? "gpt-6-astra" : "deepseek-flash",
    },
    inject: (m) => session.append("user/message", m, { surfaceOp: "append" }),
    runMaintenance: (fn) => fn(signal),
  };
  const engine = new Engine(ctx, { auto: false });
  owner.attach(agent, engine);
  function init() {
    session.append("turn/start", { turn: 1 });
    session.append("step/start", { turn: 1, step: 1 });
    session.append(
      "system/message",
      { turn: 1, step: 1, message: createSystemMessage("system") },
      { surfaceOp: "append" },
    );
    session.append(
      "user/message",
      createUserMessage({
        source: { kind: "user" },
        content: [{ type: "text", text: "task " + ".".repeat(10000) }],
      }),
      { surfaceOp: "append" },
    );
  }
  async function call(name, args = {}, failed = false) {
    const callId = "call-" + session.seq;
    const def = defs.get(name);
    session.append(
      "assistant/message",
      {
        turn: 1,
        step: 1,
        stream: [],
        message: createAssistantMessage({
          source: agent.options,
          content: [
            {
              type: "tool-call",
              id: callId,
              name,
              arguments: JSON.stringify(args),
            },
          ],
        }),
      },
      { surfaceOp: "append" },
    );
    session.append("tool/call", {
      turn: 1,
      step: 1,
      callId,
      name,
      arguments: JSON.stringify(args),
    });
    const v = failed ? {} : await def.execute(args, { signal });
    const content = failed ? [] : def.output.render(args, v);
    session.append(
      "tool/result",
      {
        turn: 1,
        step: 1,
        message: createToolResultMessage({ callId, content, isError: failed }),
        meta: failed ? {} : def.output.presentationMeta?.(args, v),
      },
      { surfaceOp: "append" },
    );
    return v;
  }
  function transport() {
    const snapshot = {
      models: { streamSimple: (_model, _context, opts) => opts },
    };
    return snapshotWithWindows(snapshot, {
      ...agent.options,
      sessionId: agent.id,
    }).models.streamSimple(
      {
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
      },
      {},
      { apiKey: "test-key" },
    );
  }
  function stop() {
    for (const fn of cleanup.reverse()) fn();
    for (const fn of events.dispose ?? []) if (typeof fn === "function") fn();
  }
  return {
    session,
    owner,
    engine,
    agent,
    ctx,
    defs,
    sections,
    contexts,
    call,
    init,
    transport,
    state: () => owner.state(agent),
    stop,
  };
}

test("OpenAI-only exact provider gating and pending model selection", () => {
  assert.equal(
    isOpenaiRoute({ provider: "openai-codex", model: "gpt-6-astra" }),
    true,
  );
  assert.equal(isOpenaiRoute({ provider: "openai", model: "o3" }), true);
  assert.equal(
    isOpenaiRoute({ provider: "deepseek", model: "gpt-6-astra" }),
    false,
  );
  const pending = { provider: "deepseek-official", model: "deepseek-flash" };
  assert.equal(
    currentRoute({
      ctx: {
        get: () => ({ agents: { selectionFor: () => ({ current: pending }) } }),
      },
      options: { provider: "openai", model: "gpt-test" },
    }),
    pending,
  );
});
test("other providers get no tools/prompt/native override and delegate all compact paths", async () => {
  const h = harness("deepseek-official");
  assert.equal(h.defs.size, 0);
  assert.equal(h.sections[0].text(), "");
  assert.equal(h.contexts[0].text(), "");
  const originals = {};
  const seen = [];
  try {
    for (const method of [
      "compactIfNeeded",
      "compactNow",
      "compactRegion",
      "summarize",
    ]) {
      originals[method] = BasicCompactionEngine.prototype[method];
      BasicCompactionEngine.prototype[method] = async () => {
        seen.push(method);
        return method;
      };
    }
    assert.equal(
      await h.engine.compactIfNeeded(h.agent, "pressure", signal),
      "compactIfNeeded",
    );
    assert.equal(await h.engine.compactNow(h.agent, signal), "compactNow");
    assert.equal(
      await h.engine.compactRegion(1, 2, h.agent, signal),
      "compactRegion",
    );
    assert.equal(await h.engine.summarize({}, h.agent, signal), "summarize");
    assert.equal(seen.length, 4);
  } finally {
    for (const [name, fn] of Object.entries(originals))
      BasicCompactionEngine.prototype[name] = fn;
    h.stop();
  }
});
test("verified notes handoff resets entire surface without model summary; replay restores state", async () => {
  const h = harness();
  const oldFetch = global.fetch;
  global.fetch = async () =>
    new Response(JSON.stringify({ encrypted_output: "opaque-backend-result" }));
  try {
    h.init();
    h.transport();
    assert.equal(h.defs.size, 11);
    await assert.rejects(
      h.defs.get("new_context").execute({ checkpoint_path: "checkpoint.txt" }),
      /Write and read back/,
    );
    await h.call("notes_write_file", {
      path: "checkpoint.txt",
      text: "encrypted-args",
    });
    assert.equal(checkpointReady(h.state()), false);
    await h.call("notes_read_file", {
      path: "checkpoint.txt",
      start_line: 1,
      stop_line: 1,
    });
    assert.equal(checkpointReady(h.state()), false);
    await h.call("notes_read_file", { path: "checkpoint.txt" });
    assert.equal(checkpointReady(h.state()), true);
    const oldWindow = h.state().windowId;
    await h.call("new_context", { checkpoint_path: "checkpoint.txt" });
    h.session.append("step/end", { turn: 1, step: 1 });
    const result = await h.engine.compactIfNeeded(h.agent, "pressure", signal);
    assert.ok(result);
    assert.equal(h.state().index, 1);
    assert.notEqual(h.state().windowId, oldWindow);
    assert.equal(h.session.surface.nodes.length, 2);
    assert.equal(
      h.session
        .snapshotEvents()
        .some(
          (e) =>
            e.type === "compaction/summary" && e.data.llmStreamCall === true,
        ),
      false,
    );
    const marker = h.session.deriveMessages().find(parseMarker);
    assert.ok(marker);
    assert.match(JSON.stringify(marker), /checkpoint.txt/);
    assert.equal(
      h.session
        .snapshotEvents()
        .some(
          (e) =>
            e.type === "user/message" &&
            JSON.stringify(e.data).includes("task "),
        ),
      true,
    );
    const replay = h.session
      .snapshotEvents()
      .reduce(foldWindow, initialWindow(h.session.header));
    assert.deepEqual(replay, h.state());
  } finally {
    global.fetch = oldFetch;
    h.stop();
  }
});
test("failed operations, new user inputs, ordinary work and account switches do not authorize reset", async () => {
  const h = harness();
  const oldFetch = global.fetch;
  global.fetch = async () =>
    new Response(JSON.stringify({ encrypted_output: "opaque" }));
  try {
    h.init();
    h.transport();
    await h.call("notes_write_file", { path: "c", text: "x" });
    await h.call("notes_read_file", { path: "c" });
    assert.ok(checkpointReady(h.state()));
    assert.throws(
      () =>
        snapshotWithWindows(
          { models: { streamSimple() {} } },
          { ...h.agent.options, sessionId: h.agent.id },
        ).models.streamSimple(
          { api: "openai-codex-responses", baseUrl: "https://other.invalid" },
          {},
          { apiKey: "other-key" },
        ),
      /different endpoint\/account/,
    );
    h.session.append(
      "user/message",
      createUserMessage({
        source: { kind: "user" },
        content: [{ type: "text", text: "new task" }],
      }),
      { surfaceOp: "append" },
    );
    assert.equal(checkpointReady(h.state()), false);
    await assert.rejects(h.engine.compactNow(h.agent, signal), /checkpoint/);
    await assert.rejects(
      h.engine.compactIfNeeded(h.agent, "context-overflow", signal),
      /without a verified handoff/,
    );
    await h.call("notes_write_file", { path: "c", text: "x" });
    await h.call("notes_read_file", { path: "c" });
    assert.ok(checkpointReady(h.state()));
    let state = h.state();
    state = foldWindow(state, {
      type: "tool/call",
      data: { callId: "effect", name: "bash" },
    });
    state = foldWindow(state, {
      type: "tool/result",
      seq: h.session.seq + 1,
      data: { message: { toolCallId: "effect" }, meta: {} },
    });
    assert.equal(checkpointReady(state), false);
    await assert.rejects(
      h.defs
        .get("notes_write_file")
        .execute({ path: "/root/other/notes/x", text: "x" }, { signal }),
      /current agent/,
    );
  } finally {
    global.fetch = oldFetch;
    h.stop();
  }
});
test("model changes remove scoped tools and unloading removes adapter ownership", () => {
  const h = harness();
  assert.equal(h.defs.size, 11);
  h.agent.options = { provider: "deepseek-official", model: "deepseek-flash" };
  h.owner.sync(h.agent);
  assert.equal(h.defs.size, 0);
  h.stop();
  const snapshot = { models: {} };
  assert.equal(
    snapshotWithWindows(snapshot, {
      provider: "openai-codex",
      model: "gpt-6-astra",
      sessionId: h.agent.id,
    }),
    snapshot,
  );
});
test("manual compact uses a verified checkpoint and resets the complete window", async () => {
  const h = harness();
  const oldFetch = global.fetch;
  global.fetch = async () =>
    new Response(JSON.stringify({ encrypted_output: "opaque" }));
  try {
    h.init();
    h.transport();
    await h.call("notes_write_file", { path: "manual", text: "encrypted" });
    await h.call("notes_read_file", { path: "manual" });
    h.session.append("step/end", { turn: 1, step: 1 });
    h.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    const result = await h.engine.compactNow(h.agent, signal);
    assert.ok(result);
    assert.equal(h.session.surface.nodes.length, 2);
    assert.equal(h.state().index, 1);
  } finally {
    global.fetch = oldFetch;
    h.stop();
  }
});
test("forked window checkpoints keep remote recovery scope but have unique thread/window IDs", () => {
  const parent = initialWindow({ id: "parent" }),
    child = initialWindow({ id: "child" });
  const marker = {
    version: 1,
    ownerId: "parent",
    sessionId: parent.sessionId,
    windowId: "parent-window",
    index: 1,
    backend: "backend",
  };
  const next = foldWindow(child, {
    type: "user/message",
    seq: 99,
    data: {
      source: { kind: "compact-checkpoint" },
      content: [
        { type: "text", text: "<dsh-openai-window>" + JSON.stringify(marker) },
      ],
    },
  });
  assert.equal(next.sessionId, parent.sessionId);
  assert.notEqual(next.threadId, parent.threadId);
  assert.notEqual(next.windowId, marker.windowId);
  assert.equal(next.agentName, child.agentName);
});
test("first-turn added prompt/tool token estimate is bounded and explicit", () => {
  const chars = WINDOW_GUIDANCE.length + JSON.stringify(windowTools).length;
  const addedTokens = Math.ceil(chars / 4);
  assert.ok(addedTokens < 5000);
  console.log(
    `OpenAI rolling-window first-turn heuristic overhead: +${addedTokens} tokens; other providers: +0`,
  );
});
