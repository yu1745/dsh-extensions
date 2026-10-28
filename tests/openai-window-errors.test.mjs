import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({ entryPoints: [new URL('../src/openai-window-protocol.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' });
const { callWindowBackend, WindowBackendError } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const backend = { baseURL: 'https://example.invalid/v1', apiKey: 'private-key', sessionId: 'test', agentName: '/root' };
async function withFetch(fn, body) {
  const previous = globalThis.fetch; globalThis.fetch = fn;
  try { return await body(); } finally { globalThis.fetch = previous; }
}

test('alpha backend errors classify HTTP, transport and protocol without exposing secrets', async () => {
  for (const [fetch, kind, status] of [
    [async () => new Response('secret-body', { status: 404 }), 'http', 404],
    [async () => { throw new Error('private-error'); }, 'transport', undefined],
    [async () => new Response('bad json'), 'protocol', undefined],
  ]) await withFetch(fetch, async () => {
    await assert.rejects(callWindowBackend(backend, 'notes_read_file', {}), (error) => {
      assert.ok(error instanceof WindowBackendError); assert.equal(error.kind, kind); assert.equal(error.status, status);
      assert.doesNotMatch(error.message, /private|secret/); return true;
    });
  });
});

test('caller cancellation is not a backend transport failure', async () => {
  const controller = new AbortController();
  await withFetch(async (_url, { signal }) => {
    controller.abort(); assert.ok(signal.aborted); throw new Error('private');
  }, async () => {
    await assert.rejects(callWindowBackend(backend, 'notes_read_file', {}, controller.signal), (error) => {
      assert.equal(error.kind, 'cancelled'); return true;
    });
  });
});
