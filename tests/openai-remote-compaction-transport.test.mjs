import test from "node:test";
import assert from "node:assert/strict";
import { requestRemoteCompaction } from "../src/openai-remote-compaction-transport.mjs";

const input = { model: "model", instructions: "system", input: [{ role: "user", content: "hi" }], stream: true, store: false };
const cp = { type: "response.output_item.done", item: { type: "compaction", encrypted_content: "opaque" } };
const complete = { type: "response.completed", response: { id: "response-1", status: "completed", usage: { input_tokens: 8 } } };
const event = (value) => `data: ${JSON.stringify(value)}\n\n`;
const chunked = (text, size = 3) => {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({ pull(controller) {
    if (offset >= bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(offset, offset += size));
  } });
};
const stub = (stream) => async () => new Response(stream, { status: 200 });
const run = (fetch, extra = {}) => requestRemoteCompaction({ endpoint: "https://example.invalid/codex/responses", request: input, fetch, ...extra });
const code = (expected) => (error) => { assert.equal(error.code, expected); return true; };

test("posts v2 trigger, preserves auth and merges beta features with streamed CRLF/multidata", async () => {
  let sent;
  const text = ': comment\r\n' +
    'data: {"type":"response.output_item.done",\r\n' +
    'data: "item":{"type":"compaction","encrypted_content":"opaque-汉"}}\r\n\r\n' +
    `data: ${JSON.stringify(complete)}\r\n\r\ndata: [DONE]\r\n\r\n`;
  const result = await run(async (url, init) => {
    sent = { url, init };
    return new Response(chunked(text, 1));
  }, { headers: { Authorization: "Bearer secret", "X-Codex-Beta-Features": "another,remote_compaction_v2,another", "x-other": "yes", 'content-encoding': 'zstd', 'content-length': '99' } });
  assert.equal(sent.url, "https://example.invalid/codex/responses");
  assert.equal(sent.init.method, "POST");
  assert.equal(sent.init.redirect, "error");
  assert.equal(sent.init.headers.get("authorization"), "Bearer secret");
  assert.equal(sent.init.headers.get('content-encoding'), null);
  assert.equal(sent.init.headers.get('content-length'), null);
  assert.equal(sent.init.headers.get("x-other"), "yes");
  assert.equal(sent.init.headers.get("x-codex-beta-features"), "another,remote_compaction_v2");
  assert.equal(sent.init.headers.get("accept"), "text/event-stream");
  assert.deepEqual(JSON.parse(sent.init.body), { ...input, input: [...input.input, { type: "compaction_trigger" }] });
  assert.deepEqual(result, { compactionOutput: { type: "compaction", encrypted_content: "opaque-汉" }, responseId: "response-1", tokenUsage: { input_tokens: 8 } });
  assert.equal(input.input.length, 1);
});

test("accepts final unterminated SSE event and compaction_summary without rewriting", async () => {
  const summary = { type: "response.output_item.done", item: { type: "compaction_summary", encrypted_content: "opaque" } };
  const result = await run(stub(chunked(event(summary) + `data: ${JSON.stringify(complete)}`, 5)));
  assert.equal(result.compactionOutput.type, "compaction_summary");
});

test("rejects duplicate, missing, malformed, incomplete or unfinished completion", async () => {
  const cases = [
    [event(cp) + event(cp) + event(complete), "duplicate-compaction"],
    [event({ type: 'response.output_item.done', item: { type: 'function_call', name: 'unexpected', call_id: 'x', arguments: '{}' } }) + event(cp) + event(complete), "unexpected-output-item"],
    [event(complete), "invalid-completion"],
    [event({ ...cp, item: { type: "compaction", encrypted_content: "" } }) + event(complete), "invalid-compaction"],
    [event(cp) + event({ type: "response.incomplete", response: { secret: "private" } }), "response-incomplete"],
    [event(cp) + 'data: [DONE]\n\n', "unfinished-stream"],
    [event(cp), "unfinished-stream"],
    [event(cp) + event({ type: "response.completed", response: { id: "x", status: "incomplete" } }), "response-incomplete"],
    [event(cp) + event({ type: "response.completed" }), "invalid-completion"],
    [event(cp) + event({ type: 'response.completed', response: { id: 'x', status: 'completed', output: [cp.item, { type: 'message', content: 'unexpected' }] } }), 'inconsistent-completion'],
    [event(cp) + event(complete) + event(cp), "invalid-stream"],
    ['data: not-json secret\n\n', "invalid-event"],
  ];
  for (const [text, expected] of cases) await assert.rejects(run(stub(chunked(text))), code(expected));
});

test("bounds stream bytes, event bytes, event count, and rejects invalid UTF-8", async () => {
  const text = event(cp) + event(complete);
  await assert.rejects(run(stub(chunked(text)), { limits: { maxBytes: 16 } }), code("stream-size-limit"));
  await assert.rejects(run(stub(chunked(text)), { limits: { maxEventBytes: 16 } }), code("event-size-limit"));
  await assert.rejects(run(stub(chunked(event({ type: "ping" }) + text)), { limits: { maxEvents: 1 } }), code("event-limit"));
  await assert.rejects(run(stub(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([255])); c.close(); } }))), code("invalid-utf8"));
});

test("never leaks error body, SSE error details, fetch exception, or credentials", async () => {
  const secret = "secret-do-not-report";
  for (const fetch of [
    async () => new Response(secret, { status: 401 }),
    stub(chunked(event({ type: "error", error: { message: secret } }))),
    async () => { throw new Error(secret); },
  ]) {
    await assert.rejects(run(fetch, { headers: { authorization: `Bearer ${secret}` } }), (error) => {
      assert.ok(!String(error).includes(secret));
      assert.ok(!JSON.stringify(error).includes(secret));
      return true;
    });
  }
});

test("cancellation and timeout abort even when injected fetch ignores the signal", async () => {
  const never = () => new Promise(() => {});
  const before = new AbortController(); before.abort("secret");
  await assert.rejects(run(never, { signal: before.signal }), code("cancelled"));
  const during = new AbortController();
  const pending = run(never, { signal: during.signal });
  during.abort("secret");
  await assert.rejects(pending, code("cancelled"));
  await assert.rejects(run(never, { limits: { timeoutMs: 10 } }), code("timeout"));
});

test('completed DONE returns even if the SSE connection remains open', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(event(cp) + event(complete) + 'data: [DONE]\n\n')); }, pull() { return new Promise(() => {}); } });
  const result = await run(stub(body), { limits: { timeoutMs: 30 } });
  assert.equal(result.responseId, 'response-1');
});
test("cancellation and timeout stop a stalled reader", async () => {
  const stalled = () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }));
  const controller = new AbortController();
  const pending = run(stalled, { signal: controller.signal });
  queueMicrotask(() => controller.abort());
  await assert.rejects(pending, code("cancelled"));
  await assert.rejects(run(stalled, { limits: { timeoutMs: 10 } }), code("timeout"));
});

test("rejects invalid request before fetch without disclosing its content", async () => {
  let called = false;
  await assert.rejects(run(() => { called = true; }, { request: { ...input, input: [{ type: "compaction_trigger" }] } }), code("invalid-request"));
  assert.equal(called, false);
});
