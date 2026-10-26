import test from "node:test";
import assert from "node:assert/strict";

const { sanitizePromptText, sanitizePromptAssembly } = await import(
  "../lib/prompt-sanitize.js"
);

test("rewrites the flagged product name", () => {
  assert.equal(
    sanitizePromptText("You are an AI agent powered by DeepSeek Harness."),
    "You are an AI agent powered by DSH.",
  );
  assert.equal(
    sanitizePromptText(
      "The runtime context names the DeepSeek Harness implementation checkout.",
    ),
    "The runtime context names the DSH implementation checkout.",
  );
  assert.equal(
    sanitizePromptText(
      "through the DeepSeek Harness Web GUI whose URL the runtime context names.",
    ),
    "through the DSH Web GUI whose URL the runtime context names.",
  );
});

test("matches case-insensitively and across varied whitespace", () => {
  assert.equal(sanitizePromptText("deepseek harness"), "DSH");
  assert.equal(sanitizePromptText("DEEPSEEK HARNESS"), "DSH");
  assert.equal(sanitizePromptText("DeepSeek  Harness"), "DSH");
  assert.equal(sanitizePromptText("DeepSeek\nHarness"), "DSH");
  assert.equal(sanitizePromptText("a DeepSeek\tHarness b"), "a DSH b");
});

test("leaves lookalikes alone", () => {
  for (const text of [
    "DeepSeek",
    "Harness",
    "DeepSeekHarness",
    "DeepSeek-Harness",
    "deepseek-v4.1-flash",
    "deepseek-v4-pro",
    "window.__DSH_BOOT__",
  ])
    assert.equal(sanitizePromptText(text), text);
});

test("rewrites every occurrence", () => {
  assert.equal(
    sanitizePromptText("DeepSeek Harness and deepseek harness"),
    "DSH and DSH",
  );
});

test("is idempotent", () => {
  const once = sanitizePromptText("powered by DeepSeek Harness");
  assert.equal(sanitizePromptText(once), once);
});

test("rewrites sections, contexts and variables", () => {
  const tools = [{ name: "bash", description: "run a command" }];
  const assembly = {
    sections: [
      {
        name: "harness:identity",
        text: "You are an AI agent powered by DeepSeek Harness.",
      },
      { name: "yu:plain", text: "no product name here", interpolate: false },
    ],
    contexts: [
      { name: "runtime", text: "checkout the DeepSeek Harness implementation" },
    ],
    tools,
    variables: { product: "DeepSeek Harness", model: "deepseek-v4.1-flash" },
  };
  const out = sanitizePromptAssembly(assembly);
  assert.deepEqual(out.sections, [
    { name: "harness:identity", text: "You are an AI agent powered by DSH." },
    { name: "yu:plain", text: "no product name here", interpolate: false },
  ]);
  assert.deepEqual(out.contexts, [
    { name: "runtime", text: "checkout the DSH implementation" },
  ]);
  assert.deepEqual(out.variables, {
    product: "DSH",
    model: "deepseek-v4.1-flash",
  });
  assert.equal(out.tools, tools);
});

test("tolerates a partial assembly and keeps untouched fields", () => {
  assert.deepEqual(sanitizePromptAssembly({}), {});
  assert.deepEqual(
    sanitizePromptAssembly({ sections: [{ name: "a", text: "" }] }),
    { sections: [{ name: "a", text: "" }] },
  );
  const variables = { missing: undefined };
  assert.deepEqual(sanitizePromptAssembly({ variables }), { variables });
});

test("installed hook rewrites the downstream waterfall result", async () => {
  const { installPromptSanitizer } = await import("../lib/prompt-sanitize.js");
  let registered;
  const ctx = {
    on: (event, listener) => ((registered = { event, listener }), () => {}),
  };
  installPromptSanitizer(ctx);
  assert.equal(registered.event, "system-prompt/assemble");
  const assembly = {
    sections: [
      {
        name: "harness:identity",
        text: "You are an AI agent powered by DeepSeek Harness.",
      },
    ],
    contexts: [],
    tools: [],
    variables: {},
  };
  const downstream = {
    ...assembly,
    sections: [
      { name: "late", text: "added by a later listener: DeepSeek Harness" },
    ],
  };
  const out = await registered.listener(assembly, {}, async () => downstream);
  assert.deepEqual(out.sections, [
    { name: "late", text: "added by a later listener: DSH" },
  ]);
});
