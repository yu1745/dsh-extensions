// Opt-in real DSH Session + pi-ai adapter + tools + rolling transaction smoke.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { Session } from "@deepseek-ai/dsh-session";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
  BlockAssembler,
  createUserMessage,
  createSystemMessage,
  createAssistantMessage,
  createToolResultMessage,
} from "@deepseek-ai/dsh-llm";
import Windows from "../lib/openai-windows.js";
import Engine from "../lib/openai-window-compaction.js";
import {
  initialWindow,
  foldWindow,
  WINDOW_GUIDANCE,
} from "../lib/openai-window-state.js";
if (process.env.DSH_TEST_OPENAI_WINDOWS !== "1")
  throw new Error("Live network smoke requires DSH_TEST_OPENAI_WINDOWS=1");
const { tokens } = JSON.parse(
  await readFile(`${homedir()}/.codex/auth.json`, "utf8"),
);
const id = randomUUID(),
  marker = "DSH_AGENT_" + randomBytes(12).toString("hex"),
  path = "agent-smoke-" + randomBytes(6).toString("hex") + ".txt";
const defs = new Map(),
  cleanups = [],
  on = {};
const session = Session.create(id);
let state = initialWindow(session.header),
  scanned = 0;
const estimateMessage = (m) => Math.ceil(JSON.stringify(m).length / 4);
const profile = {
  piProvider: openaiCodexProvider(),
  modelErrors: new Map(),
  configuredMaxTokens: new Map(),
  streamIdleTimeoutMs: 45000,
  headers: { "ChatGPT-Account-ID": tokens.account_id },
  timeoutMs: 45000,
};
const profiles = new Map([["openai-codex", profile]]);
const adapter = new PiAiAdapter({
  profiles: () => profiles,
  resolveApiKey: async () => undefined,
  auth: {
    credentials: {
      read: async () => ({
        type: "oauth",
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expires:
          JSON.parse(
            Buffer.from(
              tokens.access_token.split(".")[1],
              "base64url",
            ).toString(),
          ).exp * 1000,
        accountId: tokens.account_id,
      }),
      list: async () => ["openai-codex"],
      modify: async () => {
        throw new Error("Smoke never refreshes credentials");
      },
      delete: async () => {},
    },
    authContext: { getEnv: () => undefined },
  },
});
const ctx = {
  reflect: { provide() {} },
  on: (event, fn) => {
    (on[event] ??= []).push(fn);
    return () => {};
  },
  get: () => undefined,
  logger: { warn: console.warn, info() {} },
  agents: {},
  sessions: { flush: async () => {} },
  llm: {
    resolveModelInfo: () => adapter.resolveModel("openai-codex", "gpt-6-astra"),
  },
  sessionProjections: {
    register: () => () => {},
    stateOf: () => {
      for (const event of session.snapshotEvents(scanned))
        state = foldWindow(state, event);
      scanned = session.seq;
      return state;
    },
  },
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
    cleanups.push(stop);
    return stop;
  },
  tools: {
    presentAs: () => () => {},
    register: (def) => {
      defs.set(def.name, def);
      return () => defs.delete(def.name);
    },
  },
  systemPrompt: { section: () => () => {}, context: () => () => {} },
};
const agent = {
  id,
  session,
  ctx: scope,
  options: { provider: "openai-codex", model: "gpt-6-astra" },
  inject: (message) =>
    session.append("user/message", message, { surfaceOp: "append" }),
};
const engine = new Engine(ctx, { auto: false });
owner.attach(agent, engine);
const system =
  "Run only the integration diagnostic. " +
  WINDOW_GUIDANCE +
  ' Before rollover, write the given exact synthetic content to the requested note, read the entire note back, then call new_context. After rollover, recover the checkpoint note, search for its entire exact content using notes_search_contents, then list history windows with history_list_windows and use history_search_contents to locate that marker in the old window (not the current window). Use returned window IDs unchanged. Then output only JSON {"READ_OK":true,"SEARCH_OK":true,"HISTORY_OK":true,"recovered_content":"..."}. Never claim success without actual evidence.';
const controller = new AbortController();
const timer = setTimeout(() => controller.abort("Smoke timeout"), 180000);
let final = "",
  rolled = false;
try {
  session.append("turn/start", { turn: 1 });
  session.append(
    "system/message",
    { turn: 1, step: 0, message: createSystemMessage(system) },
    { surfaceOp: "append" },
  );
  session.append(
    "user/message",
    createUserMessage({
      source: { kind: "user" },
      content: [
        {
          type: "text",
          text: `Synthetic diagnostic: note path ${path}, exact content ${marker}. Save, verify and start a fresh window, then recover and search as instructed. Padding for a useful reset:\n${".".repeat(4000)}`,
        },
      ],
    }),
    { surfaceOp: "append" },
  );
  for (let step = 1; step <= 14; step++) {
    if (owner.state(agent).pending) {
      await engine.compactIfNeeded(agent, "pressure", controller.signal);
      rolled = true;
      console.log(
        "DSH full surface rollover committed; old input marker absent:",
        !session
          .deriveMessages()
          .some(
            (m) =>
              m.role === "user" &&
              m.content.some(
                (b) => b.type === "text" && b.text.includes(marker),
              ),
          ),
      );
    }
    session.append("step/start", { turn: 1, step });
    const tools = [...defs.values()].map(
      ({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      }),
    );
    session.append("request/header", {
      header: { config: agent.options, tools },
      reason: step === 1 ? "initial" : "series",
    });
    const assembler = new BlockAssembler();
    let replayState;
    for await (const chunk of adapter.stream({
      ...agent.options,
      sessionId: id,
      messages: session.deriveMessages(),
      tools,
      signal: controller.signal,
    })) {
      assembler.push(chunk);
      if (chunk.type === "finish") replayState = chunk.replayState;
    }
    if (["error", "aborted"].includes(assembler.finish.kind))
      throw new Error(assembler.finish.failure.message);
    const blocks = assembler.blocks();
    session.append(
      "assistant/message",
      {
        turn: 1,
        step,
        stream: [],
        message: createAssistantMessage({
          source: { ...agent.options, ...(replayState ? { replayState } : {}) },
          content: blocks,
        }),
      },
      { surfaceOp: "append" },
    );
    const calls = blocks.filter((b) => b.type === "tool-call");
    for (const call of calls) {
      console.log("DSH tool:", call.name);
      session.append("tool/call", {
        turn: 1,
        step,
        callId: call.id,
        name: call.name,
        arguments: call.arguments,
      });
      const def = defs.get(call.name);
      if (!def) throw new Error("Unexpected tool " + call.name);
      const args = JSON.parse(call.arguments),
        value = await def.execute(args, {
          signal: controller.signal,
          agent,
          callId: call.id,
        });
      session.append(
        "tool/result",
        {
          turn: 1,
          step,
          message: createToolResultMessage({
            callId: call.id,
            content: def.output.render(args, value),
            isError: false,
          }),
          meta: def.output.presentationMeta?.(args, value),
        },
        { surfaceOp: "append" },
      );
    }
    session.append("step/end", { turn: 1, step });
    if (!calls.length) {
      final = blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      break;
    }
  }
  const parsed = JSON.parse(final.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  if (
    !rolled ||
    parsed.READ_OK !== true ||
    parsed.SEARCH_OK !== true ||
    parsed.HISTORY_OK !== true ||
    parsed.recovered_content !== marker
  )
    throw new Error("End-to-end recovery mismatch");
  console.log(
    "DSH Session + actual pi-ai adapter + remote notes + fresh-window exact read/search: PASS",
  );
  console.log("Model result:", JSON.stringify(parsed));
  console.log(
    "Preserved durable events:",
    session.seq,
    "current surface nodes:",
    session.surface.nodes.length,
  );
} finally {
  clearTimeout(timer);
  for (const fn of cleanups.reverse()) fn();
  for (const fn of on.dispose ?? []) fn();
}
