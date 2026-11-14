#!/usr/bin/env node
// 就绪判断的端到端检查：真实站点 + 真实 Jev，需要联网和 TYPESAFE_API_KEY，不属于 `npm test`。
//   node scripts/readiness-e2e.mjs [输出目录] [站点 URL ...]
// 先 `npm run build`。每个站点输出：最终判定、耗时、请求次数，以及最后一次回答里各原子问题的概率；
// 目录里保存判定瞬间的截图和 results.json。密钥只从环境变量或 DSH credentials 的 refs 读取，不打印。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { typesafeProvider } from "@earendil-works/pi-ai/providers/typesafe";
import { chromium } from "playwright";

const outDir = resolve(process.argv[2] ?? "readiness-e2e-out");
const argSites = process.argv.slice(3);
mkdirSync(outDir, { recursive: true });

const SITES = argSites.length ? argSites : [
  "https://www.lemonde.fr/", "https://www.lefigaro.fr/", "https://www.bbc.com/news", "https://www.theguardian.com/international",
  "https://www.spiegel.de/", "https://www.amazon.fr/", "https://www.booking.com/", "https://www.youtube.com/", "https://www.reddit.com/",
  "https://medium.com/", "https://www.leboncoin.fr/", "https://www.cnn.com/", "https://www.nytimes.com/", "https://www.twitch.tv/",
  "https://www.cookiebot.com/en/", "https://www.onetrust.com/", "https://www.didomi.io/", "https://stackoverflow.com/questions",
  "https://en.wikipedia.org/wiki/Cookie", "https://example.com/", "https://developer.mozilla.org/en-US/docs/Web/HTTP/Cookies",
  "https://github.com/microsoft/playwright/issues", "https://news.ycombinator.com/",
];

function readKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  const text = readFileSync(join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".credentials.yaml"), "utf8");
  const match = /^\s*TYPESAFE_API_KEY:\s*['"]?([^'"\s#]+)/m.exec(text);
  if (!match) throw new Error("TYPESAFE_API_KEY not found in credentials");
  return match[1];
}
const apiKey = readKey();
const models = createModels({
  credentials: { read: async () => ({ type: "api_key", key: apiKey }), list: async () => [], modify: async () => { throw new Error("read-only"); }, delete: async () => {} },
});
models.setProvider(typesafeProvider());
const model = models.getModelOfType("classifier", "typesafe", process.env.JEV_MODEL ?? "jev-latest");
if (!model) throw new Error("typesafe classifier model is unavailable");

let calls = [];
const jev = {
  async evaluate(request, options = {}) {
    const started = Date.now();
    const result = await models.classify(model, request, { signal: options.signal, maxRetries: 0 });
    if (result.stopReason !== "stop") throw new Error(result.errorMessage || "Jev failed");
    calls.push({ ms: Date.now() - started, image: !!request.images?.length, answers: Object.fromEntries(Object.entries(result.answers ?? {}).map(([id, a]) => [id, a.probability])) });
    return result;
  },
};

const { waitForReadableContent, withConsentTools } = await import("../lib/web-reader.js");
const browser = await chromium.launch({ headless: true });
const results = [];
for (const [index, url] of SITES.entries()) {
  const name = `${String(index + 1).padStart(2, "0")}-${new URL(url).hostname}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 1536 }, locale: "fr-FR" });
  const page = await context.newPage();
  calls = [];
  const row = { url };
  const started = Date.now();
  try {
    await page.goto(url, { waitUntil: "commit", timeout: 20000 }).catch((e) => { row.gotoError = String(e.message).slice(0, 80); });
    await page.waitForLoadState("load", { timeout: 1000 }).catch(() => {});
    row.navMs = Date.now() - started;
    const tools = withConsentTools(page);
    if (process.env.FORCE_CLEAR) { // 强制先清除一次，用来单独验证点击/隐藏本身（含 iframe 里的弹窗）
      await page.waitForTimeout(6000);
      await page.screenshot({ type: "png" }).then((image) => writeFileSync(join(outDir, `${name}-before-clear.png`), image)).catch(() => {});
      row.textBeforeClear = await page.evaluate("document.body.innerText.length").catch(() => 0);
      row.forcedClear = await tools.clearConsentOverlay();
      row.textAfterClear = await page.evaluate("document.body.innerText.length").catch(() => 0);
    }
    const verdict = await waitForReadableContent(tools, url, jev);
    row.overlayCleared = verdict.overlayCleared;
    row.ms = Date.now() - started;
    row.readyMs = row.ms - row.navMs;
    row.verdict = verdict.blocked ? `blocked:${verdict.blocked}` : verdict.incomplete ? "incomplete" : "ready";
    row.requests = calls.length;
    row.jevMs = calls.map((c) => c.ms);
    row.last = calls.at(-1)?.answers;
    await page.screenshot({ type: "png", timeout: 5000 }).then((image) => writeFileSync(join(outDir, `${name}.png`), image)).catch(() => {});
  } catch (error) {
    row.error = String(error?.message ?? error).slice(0, 120);
    row.ms = Date.now() - started;
  }
  results.push(row);
  const l = row.last ?? {};
  const top = Object.entries(l).filter(([id]) => !["main_content_present", "still_loading"].includes(id)).sort((a, b) => b[1] - a[1])[0];
  console.log(`${name.padEnd(34)} ${String(row.verdict ?? row.error).padEnd(22)} ${String(row.ms).padStart(5)}ms (nav ${row.navMs ?? "-"} + judge ${row.readyMs ?? "-"}) req=${row.requests ?? "-"} cleared=${row.overlayCleared ?? row.forcedClear ? JSON.stringify(row.overlayCleared ?? row.forcedClear) : "-"}  main=${l.main_content_present?.toFixed(2) ?? "-"} loading=${l.still_loading?.toFixed(2) ?? "-"} top-blocker=${top ? `${top[0]}:${top[1].toFixed(2)}` : "-"}`);
  await context.close();
}
await browser.close();
writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
const ms = results.map((r) => r.ms).filter(Number.isFinite).sort((a, b) => a - b);
console.log(`\n中位耗时 ${ms[Math.floor(ms.length / 2)]}ms，最大 ${ms.at(-1)}ms\n结果：${join(outDir, "results.json")}`);
