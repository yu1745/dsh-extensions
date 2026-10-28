import test from 'node:test';
import assert from 'node:assert/strict';
import { Module, createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { build } from 'esbuild';
const filename = resolve('src/.context-test.cjs');
const code = (await build({ entryPoints: [resolve('src/openai-context-settings.tsx')], bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false })).outputFiles[0].text;
const mod = new Module(filename); mod.filename = filename; mod.paths = Module._nodeModulePaths(dirname(filename)); mod.require = createRequire(filename); mod._compile(code, filename);
const { installOpenaiContextSettings } = mod.exports;
test('registers a localized Settings section with a stable official settings API', () => {
  const effects = [], registered = [], dictionaries = [], events = {};
  const locale = { register(ns, language, dict) { dictionaries.push({ ns, language, dict }); return () => {}; }, bind() { return key => key === 'title' ? 'OpenAI 上下文' : key; }, subscribe() { return () => {}; }, getSnapshot() { return { active: 'zh', revision: 1 }; } };
  const scope = { locale, remote: { $on() { return () => {}; }, settings: { describe: async () => ({ ok: true, value: { writable: true, namespaces: [] } }), update: async () => ({ ok: true }) } },
    effect(fn) { effects.push(fn()); }, on(name, fn) { events[name] = fn; return () => {}; },
    slots: { inject(name, fn) { assert.equal(name, 'settings.section'); fn(); return () => {}; }, register(options, component) { registered.push({ options, component }); return () => {}; } } };
  installOpenaiContextSettings({ inject(names, fn) { assert.deepEqual(names, ['remote.settings', 'locale']); fn(scope); } });
  assert.deepEqual(dictionaries.map(x => x.language), ['en', 'zh']);
  assert.equal(registered[0].options.id, 'yu-openai-context'); assert.equal(registered[0].options.label(), 'OpenAI 上下文');
  assert.equal(typeof registered[0].component, 'function');
  events['locale/change'](); assert.equal(registered.length, 2);
  for (const dispose of effects.reverse()) dispose();
});
