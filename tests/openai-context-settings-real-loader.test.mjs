import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// This optional integration test uses an explicit installed DSH package anchor;
// it never opens or edits the user's active profile.
const installedBase = process.env.DSH_TEST_BASE_MANIFEST;
test('real Loader and Settings persist mode and update live Config Reference with conflict fencing', { skip: !installedBase && 'Set DSH_TEST_BASE_MANIFEST to an installed dsh-base package.json' }, async (t) => {
  const baseRequire = createRequire(installedBase);
  const editorModule = baseRequire.resolve('@deepseek-ai/dsh-config-editor');
  const settingsModule = baseRequire.resolve('@deepseek-ai/dsh-settings');
  const bootModule = createRequire(editorModule).resolve('@deepseek-ai/dsh-app-boot');
  const actualOwner = new URL('../lib/openai-windows.js', import.meta.url).href;
  const { boot, initProfile, readProfilePatches } = await import(pathToFileURL(bootModule));
  const tempRoot = await realpath(tmpdir());
  const temp = await mkdtemp(join(tempRoot, 'dsh-settings-isolation-'));
  let ctx;
  // Only delete the exact fresh directory created above, never a computed user path.
  t.after(async () => {
    await ctx?.fiber.dispose();
    assert.equal(dirname(temp), tempRoot);
    assert.ok(basename(temp).startsWith('dsh-settings-isolation-'));
    assert.equal(await realpath(temp), temp);
    await rm(temp, { recursive: true, force: true });
  });
  const profile = join(temp, 'profile'), home = join(temp, 'home');
  await mkdir(home);
  initProfile(profile, []);
  const root = join(profile, 'root.yml'), patchPath = join(profile, 'cordis.patch.yml');
  await writeFile(root, '[]\n');
  // These are fixture files under the unique temporary directory only.
  await writeFile(join(profile, 'editor.mjs'), `export { default } from ${JSON.stringify(pathToFileURL(editorModule).href)};\n`);
  await writeFile(join(profile, 'settings.mjs'), `export { default } from ${JSON.stringify(pathToFileURL(settingsModule).href)};\n`);
  const ownerPackage = join(profile, 'node_modules', '@yu1745', 'dsh-extensions');
  await mkdir(ownerPackage, { recursive: true });
  await writeFile(join(ownerPackage, 'package.json'), JSON.stringify({ name: '@yu1745/dsh-extensions', version: '0.0.0', type: 'module', exports: { './openai-windows': './owner.mjs' } }));
  await writeFile(join(ownerPackage, 'owner.mjs'), `import Owner from ${JSON.stringify(actualOwner)};\nexport const Config=Owner.Config;\nexport function apply(ctx, config){ ctx.provide('testWindowOwner', { config }); }\n`);
  await writeFile(patchPath, JSON.stringify([{ insert: [
    { id: 'config-editor', name: './editor.mjs' },
    { id: 'settings', name: './settings.mjs' },
    { id: 'yu-openai-windows', name: '@yu1745/dsh-extensions/openai-windows', config: { thresholdRatio: 0.7 } },
  ] }], null, 2));
  const profileContext = { name: 'isolated-test', dir: profile, patchPath, installAnchor: installedBase, cwd: profile, home, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined };
  ctx = await boot('test', root, readProfilePatches('test', profileContext), host => host.provide('profileContext', profileContext));
  assert.ok(ctx.settings, 'real SettingsForms is active');
  assert.ok(ctx.configEditor, 'real ConfigEditor is active');
  const entries = ctx.configEditor.entries();
  const entry = entries.find(e => e.options.id === 'yu-openai-windows');
  assert.ok(entry, 'direct child of root include is exposed');
  assert.equal(entry.parent.tree.ctx.fiber.entry.id, 'include');
  const first = ctx.settings.describe({ redactSecrets: true }).find(d => d.ns === 'yu-openai-windows');
  assert.ok(first, 'namespace appears under exact profile patch ID');
  assert.equal(ctx.settings.writable, true);
  assert.equal(first.value.mode, 'windows');
  assert.equal(first.applies, 'live');
  const reference = entry.fiber.config.mode;
  assert.equal(typeof reference.get, 'function');
  assert.equal(reference.get(), 'windows');
  await ctx.settings.update('yu-openai-windows', { mode: 'remote' }, first.revision);
  assert.equal(reference.get(), 'remote', 'same owner Config Reference sees update');
  const second = ctx.settings.describe({ redactSecrets: true }).find(d => d.ns === 'yu-openai-windows');
  assert.equal(second.value.mode, 'remote');
  assert.ok(second.revision > first.revision);
  assert.match(await readFile(patchPath, 'utf8'), /mode:\s*remote/);
  await assert.rejects(ctx.settings.update('yu-openai-windows', { mode: 'windows' }, first.revision), error => error.code === 'SETTINGS_CONFLICT');
  assert.equal(reference.get(), 'remote');
  assert.equal(ctx.settings.describe().find(d => d.ns === 'yu-openai-windows').value.mode, 'remote');
  assert.match(await readFile(patchPath, 'utf8'), /mode:\s*remote/);
});
