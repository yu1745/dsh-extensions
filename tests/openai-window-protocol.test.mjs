import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// Compile in memory: this scoped test does not need a build configuration change
// or write any lib artifacts, and never makes an actual network request.
const built = await build({
  entryPoints: [
    new URL("../src/openai-window-protocol.ts", import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node22",
});
const { windowTools, endpointFor, transformWindowPayload, callWindowBackend } =
  await import(
    `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`
  );
const identity = {
  sessionId: "session-id",
  threadId: "thread-id",
  agentName: "/root/worker",
  windowId: "thread-id:2",
  windowNumber: 2,
  contextWindowId: "019a0000-0000-7000-8000-000000000001",
};

test("all nine flat DSH tools expose supported schemas and exact official endpoints", () => {
  assert.deepEqual(
    windowTools.map((entry) => entry.name),
    [
      "notes_write_file",
      "notes_append_to_file",
      "notes_read_file",
      "notes_list_files_by_prefix",
      "notes_search_contents",
      "history_list_windows",
      "history_list_items",
      "history_read_item",
      "history_search_contents",
    ],
  );
  const allowed = new Set([
    "type",
    "oneOf",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "const",
    "description",
    "title",
    "default",
    "examples",
  ]);
  function check(schema) {
    for (const key of Object.keys(schema))
      assert.ok(allowed.has(key), `unsupported schema keyword: ${key}`);
    for (const child of Object.values(schema.properties ?? {})) check(child);
    for (const child of schema.oneOf ?? []) check(child);
  }
  for (const tool of windowTools) {
    assert.deepEqual(Object.keys(tool), ["name", "description", "parameters"]);
    check(tool.parameters);
    const split = tool.name.indexOf("_");
    assert.equal(
      endpointFor(tool.name),
      `alpha/${tool.name.slice(0, split)}/v2/${tool.name.slice(split + 1)}`,
    );
  }
  assert.equal(endpointFor("notes_thread_hint"), "alpha/notes/v2/thread_hint");
  assert.equal(endpointFor("constructor"), undefined);
  assert.equal(endpointFor("notes_delete_file"), undefined);
});

test("restores strict:false and encrypted text/query without mutating schemas", () => {
  const payload = {
    tools: windowTools.map((entry) => ({
      type: "function",
      ...structuredClone(entry),
      strict: null,
    })),
    input: [],
  };
  const before = structuredClone(payload);
  const result = transformWindowPayload(payload, identity);
  for (const tool of result.tools) {
    assert.equal(tool.strict, false);
    const encrypted = Object.entries(tool.parameters.properties)
      .filter(([, schema]) => schema.encrypted === true)
      .map(([name]) => name);
    assert.deepEqual(
      encrypted,
      tool.name.endsWith("search_contents")
        ? ["query"]
        : ["notes_write_file", "notes_append_to_file"].includes(tool.name)
          ? ["text"]
          : [],
    );
  }
  assert.deepEqual(payload, before);
  assert.deepEqual(transformWindowPayload(result, identity), result);
});

test("namespace tools are patched without renaming or replacing their schemas", () => {
  const original = {
    type: "namespace",
    name: "notes",
    description: "keep namespace description",
    tools: [
      {
        type: "function",
        name: "write_file",
        strict: null,
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", custom: "keep" },
            path: { type: "string" },
          },
          required: ["text", "path"],
        },
      },
    ],
  };
  const { tools } = transformWindowPayload({ tools: [original] }, identity);
  assert.equal(tools[0].name, "notes");
  assert.equal(tools[0].tools[0].name, "write_file");
  assert.equal(tools[0].tools[0].strict, false);
  assert.equal(tools[0].tools[0].parameters.properties.text.encrypted, true);
  assert.equal(tools[0].tools[0].parameters.properties.text.custom, "keep");
  assert.equal(
    original.tools[0].parameters.properties.text.encrypted,
    undefined,
  );
});

test("merges canonical ingestion metadata and preserves request fields and all messages", () => {
  const message = { role: "user", content: "unchanged" };
  const payload = {
    model: "gpt-test",
    instructions: "keep",
    arbitrary: { keep: true },
    input: [message],
    client_metadata: {
      custom: "value",
      "x-codex-turn-metadata": JSON.stringify({
        sandbox: "keep",
        history_ingest_requested: false,
      }),
    },
  };
  const result = transformWindowPayload(payload, identity);
  const metadata = JSON.parse(result.client_metadata["x-codex-turn-metadata"]);
  assert.equal(result.input.length, 1);
  assert.equal(result.input[0], message);
  assert.equal(result.arbitrary, payload.arbitrary);
  assert.equal(result.instructions, "keep");
  assert.equal(result.client_metadata.custom, "value");
  assert.equal(result.client_metadata["x-codex-window-id"], "thread-id:2");
  assert.deepEqual(metadata, {
    sandbox: "keep",
    history_ingest_requested: true,
    session_id: "session-id",
    thread_id: "thread-id",
    agent_name: "/root/worker",
    window_id: "thread-id:2",
    window_number: 2,
    context_window_id: identity.contextWindowId,
    request_kind: "turn",
  });
  const inferred = JSON.parse(
    transformWindowPayload(
      {},
      { sessionId: "s", windowId: "t:3", agentName: "/root" },
    ).client_metadata["x-codex-turn-metadata"],
  );
  assert.equal(inferred.window_number, 3);
  assert.equal(inferred.thread_id, "t");
  assert.equal(transformWindowPayload(null, identity), null);
});

test("replaces only marked notes/history outputs, preserving ciphertext and image detail", () => {
  const call = {
    type: "function_call",
    name: "history_read_item",
    call_id: "call-1",
    arguments: "{}",
    encrypted_function_args: [],
    encrypted_content: "call-ciphertext",
  };
  const output = {
    type: "function_call_output",
    call_id: "call-1",
    output: JSON.stringify({
      dshOpenaiWindowOutput: 1,
      encrypted_output: "opaque-ciphertext",
      images: [
        { data: "cG5n", mime_type: "image/png", detail: "original" },
        { data: "anBlZw==", mime_type: "image/jpeg" },
      ],
    }),
  };
  const unmarked = {
    type: "function_call_output",
    name: "notes_read_file",
    output: '{"encrypted_output":"do-not-rewrite"}',
  };
  const unrelated = {
    type: "function_call_output",
    name: "other_tool",
    output: output.output,
  };
  const payload = { input: [call, output, unmarked, unrelated] };
  const result = transformWindowPayload(payload, identity);
  assert.equal(result.input.length, 4);
  assert.equal(result.input[0], call);
  assert.equal(result.input[2], unmarked);
  assert.equal(result.input[3], unrelated);
  assert.deepEqual(result.input[1].output, [
    { type: "encrypted_content", encrypted_content: "opaque-ciphertext" },
    {
      type: "input_image",
      image_url: "data:image/png;base64,cG5n",
      detail: "original",
    },
    { type: "input_image", image_url: "data:image/jpeg;base64,anBlZw==" },
  ]);
  assert.equal(typeof payload.input[1].output, "string");
  assert.deepEqual(transformWindowPayload(result, identity), result);
});

test("handles namespaced calls and singleton content arrays; rejects invalid images safely", () => {
  const inputs = [
    {
      type: "function_call",
      namespace: "notes",
      name: "read_file",
      call_id: "n",
    },
    {
      type: "function_call_output",
      call_id: "n",
      output: [
        {
          type: "input_text",
          text: '{"dshOpenaiWindowOutput":1,"encrypted_output":"opaque"}',
        },
      ],
    },
  ];
  assert.deepEqual(
    transformWindowPayload({ input: inputs }, identity).input[1].output,
    [{ type: "encrypted_content", encrypted_content: "opaque" }],
  );
  assert.throws(
    () =>
      transformWindowPayload(
        {
          input: [
            {
              type: "function_call_output",
              name: "notes_read_file",
              output: JSON.stringify({
                dshOpenaiWindowOutput: 1,
                encrypted_output: "private-ciphertext",
                images: [{ data: "private-image" }],
              }),
            },
          ],
        },
        identity,
      ),
    /^Error: History backend returned invalid image content\.$/,
  );
});

const backend = {
  baseURL: "https://example.invalid/backend-api",
  apiKey: "test-key-not-a-real-credential",
  sessionId: "session-id",
  agentName: "/root/worker",
  headers: {
    "x-openai-actor-authorization": "test-actor",
    "x-codex-turn-metadata": "test-metadata",
    "x-openai-encrypted-tool-arguments": "spoofed",
  },
};
async function mockFetch(implementation, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

test("backend preserves opaque args, replaces spoofed context, and marks exactly four operations", async () => {
  const calls = [];
  await mockFetch(
    async (url, init) => {
      calls.push({ url, init });
      return new Response('{"encrypted_output":"opaque"}', {
        headers: { "content-type": "application/json" },
      });
    },
    async () => {
      for (const tool of [...windowTools, { name: "notes_thread_hint" }]) {
        const args = {
          path: "notes.md",
          text: "opaque-text",
          query: "opaque-query",
          context: { session_id: "spoofed" },
        };
        assert.deepEqual(await callWindowBackend(backend, tool.name, args), {
          encrypted_output: "opaque",
        });
        assert.deepEqual(args.context, { session_id: "spoofed" });
      }
    },
  );
  assert.equal(calls.length, 10);
  const sensitive = new Set([
    "notes_write_file",
    "notes_append_to_file",
    "notes_search_contents",
    "history_search_contents",
  ]);
  for (let index = 0; index < calls.length; index++) {
    const { url, init } = calls[index];
    const name = [...windowTools, { name: "notes_thread_hint" }][index].name;
    assert.equal(
      url,
      `https://example.invalid/backend-api/${endpointFor(name)}`,
    );
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(
      init.headers.get("x-openai-encrypted-tool-arguments"),
      sensitive.has(name) ? "true" : null,
    );
    assert.equal(
      init.headers.get("x-openai-actor-authorization"),
      "test-actor",
    );
    assert.equal(init.headers.get("x-codex-turn-metadata"), "test-metadata");
    assert.deepEqual(
      JSON.parse(init.headers.get("x-openai-tool-output-truncation-policy")),
      { mode: "bytes", limit: 32000 },
    );
    assert.deepEqual(JSON.parse(init.body), {
      path: "notes.md",
      text: "opaque-text",
      query: "opaque-query",
      context: { session_id: "session-id", current_agent_name: "/root/worker" },
    });
    assert.ok(init.signal instanceof AbortSignal);
  }
});

test("backend keeps API and proxy prefixes and only adds Codex for ChatGPT shorthand", async () => {
  const bases = [
    ["https://api.openai.com/v1", "https://api.openai.com/v1"],
    [
      "https://proxy.invalid/custom/v1/responses/",
      "https://proxy.invalid/custom/v1",
    ],
    [
      "https://chatgpt.com/backend-api",
      "https://chatgpt.com/backend-api/codex",
    ],
    [
      "https://chatgpt.com/backend-api/codex/responses",
      "https://chatgpt.com/backend-api/codex",
    ],
  ];
  for (const [baseURL, expected] of bases) {
    await mockFetch(
      async (url) => {
        assert.equal(url, `${expected}/alpha/notes/v2/read_file`);
        return new Response("{}");
      },
      () => callWindowBackend({ ...backend, baseURL }, "notes_read_file", {}),
    );
  }
});

test("backend normalizes Codex base URLs, forwards cancellation and custom truncation", async () => {
  const controller = new AbortController();
  await mockFetch(
    async (url, init) => {
      assert.equal(
        url,
        "https://example.invalid/backend-api/codex/alpha/notes/v2/read_file",
      );
      assert.deepEqual(
        JSON.parse(init.headers.get("x-openai-tool-output-truncation-policy")),
        { mode: "bytes", limit: 4000 },
      );
      controller.abort();
      assert.equal(init.signal.aborted, true);
      return new Response("{}");
    },
    () =>
      callWindowBackend(
        {
          ...backend,
          baseURL: "https://example.invalid/backend-api/codex/responses/",
          truncationPolicy: { mode: "bytes", limit: 4000 },
        },
        "notes_read_file",
        {},
        controller.signal,
      ),
  );
});

test("backend errors never include response bodies, credentials, arguments or ciphertext", async () => {
  await mockFetch(
    async () => new Response("private-ciphertext", { status: 400 }),
    async () => {
      await assert.rejects(
        callWindowBackend(backend, "notes_write_file", {
          text: "private-argument",
        }),
        /^Error: History backend request failed \(HTTP 400\)\.$/,
      );
    },
  );
  await mockFetch(
    async () => new Response("private-json-invalid"),
    async () => {
      await assert.rejects(
        callWindowBackend(backend, "notes_read_file", {}),
        /^Error: History backend returned invalid JSON\.$/,
      );
    },
  );
  await mockFetch(
    async () => {
      throw new Error("private-transport-value");
    },
    async () => {
      await assert.rejects(
        callWindowBackend(backend, "notes_read_file", {}),
        /^Error: History backend request failed\.$/,
      );
    },
  );
  await assert.rejects(
    callWindowBackend(backend, "unknown", {}),
    /Unknown history or notes operation/,
  );
  await assert.rejects(
    callWindowBackend(backend, "notes_read_file", []),
    /arguments must be a JSON object/,
  );
});
