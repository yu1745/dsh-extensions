import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { DEFAULT_OPENAI_CONTEXT_MODE, isOpenaiContextMode, settingSnapshot } from '../src/openai-context-setting-shared.mjs';
import Owner from '../lib/openai-windows.js';
import { createOpenaiContextSettingsClient } from '../src/openai-context-setting-client.mjs';

const ns = 'test-openai-settings';
function setup() {
  let row = { ns, value: { mode: 'windows', unrelated: 4 }, revision: 2 };
  let writable = true; const calls = [];
  const remote = {
    async describe() { calls.push(['read']); return { ok: true, value: { writable, namespaces: [structuredClone(row)] } }; },
    async update(name, patch, expected) {
      calls.push(['update', name, patch, expected]);
      if (!writable) return { ok: false, error: { message: 'read only' } };
      if (name !== ns || expected !== row.revision) return { ok: false, error: { message: 'conflict' } };
      row = { ...row, value: { ...row.value, ...patch }, revision: row.revision + 1 };
      return { ok: true, value: structuredClone(row) };
    },
  };
  return { remote, calls, setWritable(value) { writable = value; } };
}

test('schema defaults to windows and only accepts the two explicit modes', () => {
  assert.equal(DEFAULT_OPENAI_CONTEXT_MODE, 'windows');
  assert.equal(Owner.Config({}).mode.get(), 'windows');
  assert.equal(Owner.Config({ mode: 'remote' }).mode.get(), 'remote');
  assert.throws(() => Owner.Config({ mode: 'auto' }));
  assert.equal(isOpenaiContextMode('windows'), true);
  assert.equal(isOpenaiContextMode('remote'), true);
  for (const value of ['auto', '', null, undefined]) assert.equal(isOpenaiContextMode(value), false);
  assert.throws(() => settingSnapshot({ value: { mode: 'auto' }, revision: 1 }));
  assert.throws(() => settingSnapshot({ value: { mode: 'windows' } }));
});

test('UI write uses the official settings namespace and revision', async () => {
  const { remote, calls } = setup();
  const client = createOpenaiContextSettingsClient(remote, ns);
  assert.deepEqual(await client.read(), { mode: 'windows', remoteSpeed: 'standard', revision: 2, writable: true });
  assert.deepEqual(await client.save('remote', 2), { mode: 'remote', remoteSpeed: 'standard', revision: 3, writable: true });
  assert.deepEqual(await client.read(), { mode: 'remote', remoteSpeed: 'standard', revision: 3, writable: true });
  assert.deepEqual(calls.find(call => call[0] === 'update'), ['update', ns, { mode: 'remote' }, 2]);
});

test('revisions reject stale writes, invalid values and absent namespace without touching storage', async () => {
  const { remote, calls } = setup(); const client = createOpenaiContextSettingsClient(remote, ns);
  await client.save('remote', 2);
  await assert.rejects(client.save('windows', 2), /conflict/);
  const count = calls.length;
  await assert.rejects(client.save('auto', 3), /Invalid/);
  await assert.rejects(client.save('windows', undefined), /Invalid/);
  assert.equal(calls.length, count);
  await assert.rejects(createOpenaiContextSettingsClient(remote, 'missing').read(), /unavailable/);
});

test('read-only settings and host errors do not become successful updates', async () => {
  const { remote, setWritable } = setup(); setWritable(false);
  const client = createOpenaiContextSettingsClient(remote, ns);
  assert.equal((await client.read()).writable, false);
  await assert.rejects(client.save('remote', 2), /read only/);
  const broken = createOpenaiContextSettingsClient({ describe: async () => ({ ok: false, error: { message: 'offline' } }), update: remote.update }, ns);
  await assert.rejects(broken.read(), /offline/);
});

test('settings UI compiles for browser without generating files', async () => {
  const built = await build({ entryPoints: [new URL('../src/openai-context-settings.tsx', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['react'] });
  assert.equal(built.outputFiles.length, 1);
  assert.ok(built.outputFiles[0].text.includes('OpenaiContextSettings'));
});
