import test from 'node:test';
import assert from 'node:assert/strict';
import { requestStandardCompaction } from '../src/openai-standard-compaction.mjs';
const payload = { model: 'gpt-test', input: [{ role: 'user', content: 'original' }], instructions: 'system', prompt_cache_key: 'key', service_tier: 'priority', stream: true, tools: [{ name: 'excluded' }] };
const output = [{ role: 'user', content: [{ type: 'input_text', text: 'keep' }] }, { type: 'compaction', id: 'cmp', encrypted_content: 'opaque' }];
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function args(fetch, extra = {}) { return { endpoint: 'https://api.example.invalid/v1/responses?test=1', headers: { authorization: 'Bearer secret', 'content-encoding': 'zstd' }, payload, fetch, ...extra }; }

test('standard endpoint keeps complete ordered response and authenticates with captured headers', async () => {
  const calls = [];
  const result = await requestStandardCompaction(args(async (url, init) => { calls.push({ url, init }); return json({ object: 'response.compaction', output, usage: { input_tokens: 1 } }); }));
  assert.deepEqual(result, { output, usage: { input_tokens: 1 } });
  assert.equal(calls[0].url, 'https://api.example.invalid/v1/responses/compact?test=1');
  assert.equal(calls[0].init.headers.get('authorization'), 'Bearer secret');
  assert.equal(calls[0].init.headers.get('content-encoding'), null);
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: 'gpt-test', input: payload.input, instructions: 'system', prompt_cache_key: 'key', service_tier: 'priority' });
});
test('rejects incomplete and unknown outputs rather than clipping retained items', async () => {
  for (const value of [null, {}, { object: 'response.compaction', output: [] }, { object: 'response.compaction', output: [{ type: 'compaction', encrypted_content: '' }] }, { object: 'response.compaction', output: [...output, { type: 'unknown', content: 'private' }] }]) {
    await assert.rejects(requestStandardCompaction(args(async () => json(value))), (e) => e.code === 'invalid-output' && !e.message.includes('private'));
  }
});
test('HTTP, malformed, oversized and cancellation errors are sanitized', async () => {
  await assert.rejects(requestStandardCompaction(args(async () => new Response('secret response', { status: 401 }))), (e) => e.code === 'http-error' && e.status === 401 && !e.message.includes('secret'));
  await assert.rejects(requestStandardCompaction(args(async () => new Response('private invalid json'))), (e) => e.code === 'invalid-body' && !e.message.includes('private'));
  await assert.rejects(requestStandardCompaction(args(async () => json({ object: 'response.compaction', output }), { maxBytes: 5 })), (e) => e.code === 'body-too-large');
  const controller = new AbortController();
  const pending = requestStandardCompaction(args(async () => new Promise(() => {}), { signal: controller.signal }));
  controller.abort('private');
  await assert.rejects(pending, (e) => e.code === 'cancelled' && !e.message.includes('private'));
  await assert.rejects(requestStandardCompaction(args(async () => new Promise(() => {}), { timeoutMs: 5 })), (e) => e.code === 'timeout');
});
test('does not send to wrong endpoint or forward output on bad configuration', async () => {
  let called = false;
  await assert.rejects(requestStandardCompaction(args(async () => { called = true; }, { endpoint: 'https://evil.invalid/not-responses' })), (e) => e.code === 'invalid-endpoint');
  assert.equal(called, false);
});
