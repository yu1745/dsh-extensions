import { build } from "esbuild";
import { mkdir, writeFile, rm } from "node:fs/promises";
await rm("lib", { recursive: true, force: true });
await mkdir("lib", { recursive: true });
const nodeBuild = await build({
  metafile: true,
  entryPoints: {
    index: "src/index.ts",
    providers: "src/providers.ts",
    "codebuddy-provider": "src/codebuddy-provider.ts",
    "antigravity-provider": "src/antigravity-provider.ts",
    "codex-quota": "src/vendor/quota-footer/providers/codex.ts",
    "web-search": "src/web-search.ts",
    "web-reader": "src/web-reader.ts",
    "web-tools": "src/web-tools.ts",
    bridge: "src/bridge.ts",
    "search-openai": "src/vendor/web-search/openai-search.ts",
    quota: "src/quota.ts",
    "codex-fast": "src/codex-fast.ts",
    "model-fallback": "src/model-fallback.ts",
    "fallback-state": "src/fallback-state.ts",
    costs: "src/costs.ts",
    classifiers: "src/classifiers.ts",
    "speed-context": "src/speed-context.ts",
    "search-context": "src/search-context.ts",
    "adapter-speed": "src/adapter-speed.ts",
  },
  outdir: "lib",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  sourcemap: true,
});

const client = await build({
  entryPoints: ["src/client.tsx"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: ["react", "react-dom", "react/jsx-runtime", "@deepseek-ai/cordis"],
  jsx: "automatic",
});
await writeFile(
  "lib/client.js",
  `window.__ModuleLoader__.load({id:'@yu1745/dsh-extensions',factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`,
);

if (process.env.DSH_BUILD_INPUTS)
  await writeFile(
    process.env.DSH_BUILD_INPUTS,
    JSON.stringify(Object.keys(nodeBuild.metafile.inputs)),
  );
