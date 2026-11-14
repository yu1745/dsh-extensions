import test from "node:test";
import assert from "node:assert/strict";

const { withConsentTools } = await import("../lib/web-reader.js");
const { chromium } = await import("playwright");

let browser;
try { browser = await chromium.launch({ headless: true }); } catch { /* chromium not installed */ }
const skip = browser ? false : "bundled chromium is not installed";
test.after(async () => { await browser?.close(); });

async function open(html) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1536 } });
  const page = await context.newPage();
  await page.setContent(html);
  return { page, close: () => context.close() };
}
const consentFrame = (buttons) => `<iframe id="cmp" style="width:100%;height:100%;border:0" srcdoc="${buttons.replace(/"/g, "&quot;")}"></iframe>`;
const fixedLayer = (inner) => `<div id="layer" style="position:fixed;inset:0;z-index:2147483647">${inner}</div>`;
const ARTICLE = `<main><article><h1>Title</h1>${"<p>Real article paragraph with enough text to count as content.</p>".repeat(20)}</article></main>`;

test("clicks an explicit reject button inside an iframe and never an accept button", { skip }, async () => {
  const buttons = `<button onclick="parent.document.title='accepted'">Accept all</button><button onclick="parent.document.title='rejected'">Reject all</button><button>Manage options</button>`;
  const { page, close } = await open(`${ARTICLE}${fixedLayer(consentFrame(buttons))}`);
  const result = await withConsentTools(page).clearConsentOverlay();
  assert.equal(result.clicked, 1);
  assert.equal(await page.title(), "rejected");
  await close();
});

test("multilingual refusal labels are recognised", { skip }, async () => {
  for (const [label, expected] of [["Tout refuser", true], ["Alle ablehnen", true], ["I do not agree", true], ["Continuer sans accepter", true], ["Accepter et continuer", false], ["Consent and continue", false], ["Manage options", false]]) {
    const buttons = `<button onclick="parent.document.title='clicked'">${label}</button>`;
    const { page, close } = await open(`${ARTICLE}${fixedLayer(consentFrame(buttons))}`);
    const result = await withConsentTools(page).clearConsentOverlay();
    assert.equal(result.clicked, expected ? 1 : 0, label);
    await close();
  }
});

test("hides a full-viewport consent iframe with no reject button, and restores it", { skip }, async () => {
  const { page, close } = await open(`${ARTICLE}${fixedLayer(consentFrame(`<button>Consent and continue</button><button>Subscribe</button>`))}`);
  const tools = withConsentTools(page);
  const result = await tools.clearConsentOverlay();
  assert.equal(result.clicked, 0);
  assert.ok(result.hidden >= 1);
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("layer")).display), "none");
  assert.ok(await page.evaluate(() => document.body.innerText.includes("Real article paragraph")), "the article is untouched");
  assert.ok(await tools.restoreConsentOverlay() >= 1);
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.getElementById("layer")).display), "none");
  await close();
});

test("finds a consent layer appended after thousands of elements", { skip }, async () => {
  const filler = "<div><span>filler</span></div>".repeat(6000);
  const { page, close } = await open(`${ARTICLE}<div id="bulk">${filler}</div>${fixedLayer(consentFrame(`<button>Accept</button>`))}`);
  const result = await withConsentTools(page).clearConsentOverlay();
  assert.ok(result.hidden >= 1, "a late layer in a large DOM is still found");
  await close();
});

test("hides a dimming backdrop and a consent dialog, and releases the scroll lock", { skip }, async () => {
  const html = `<body style="overflow:hidden">${ARTICLE}
    <div id="backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.6)"></div>
    <div id="dialog" role="dialog" style="position:fixed;left:20%;top:20%;width:60%;height:40%;background:#fff">We use cookies and similar technologies. Accept or reject.</div></body>`;
  const { page, close } = await open(html);
  const result = await withConsentTools(page).clearConsentOverlay();
  assert.ok(result.hidden >= 2);
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("backdrop")).display), "none");
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("dialog")).display), "none");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).overflow), "auto");
  await close();
});

test("leaves ordinary content, small widgets and non-consent dialogs alone", { skip }, async () => {
  const html = `${ARTICLE}
    <iframe id="chat" style="position:fixed;right:16px;bottom:16px;width:320px;height:120px;border:0" srcdoc="chat"></iframe>
    <div id="nav" style="position:fixed;top:0;left:0;right:0;height:48px;background:#eee">Site header</div>
    <div id="newsletter" role="dialog" style="position:fixed;left:30%;top:30%;width:40%;height:30%;background:#fff">Subscribe to our newsletter for weekly updates.</div>`;
  const { page, close } = await open(html);
  const result = await withConsentTools(page).clearConsentOverlay();
  assert.equal(result.hidden, 0);
  for (const id of ["chat", "nav", "newsletter"]) assert.notEqual(await page.evaluate((i) => getComputedStyle(document.getElementById(i)).display, id), "none", id);
  await close();
});
