/**
 * pi extension: web_reader — Full-featured web reader backed by Playwright & Jev
 * -------------------------
 * A SPA-aware, anti-WAF web reader backed by the Playwright library.
 *
 * It drives a REAL browser (prefers your installed Chrome/Edge so the fingerprint
 * is genuine) and extracts content from Playwright's **ARIA accessibility snapshot** — the
 * exact same data source `playwright-cli` uses for its snapshots. Using the accessibility
 * tree means hidden/hover-only UI (menus, "not interested" buttons, aria-hidden clutter)
 * is naturally excluded, so the output is clean.
 *
 * Cloudflare challenges are intentionally NOT handled; such pages are reported as blocked.
 *
 * Config (env vars):
 *   DSH_WEBREADER_UA       Override User-Agent. UNSET by default — spoofing one that
 *                         contradicts the real platform is itself a bot signal.
 *   DSH_WEBREADER_STEALTH  "1" to inject stealth patches. Off by default for the same
 *                         reason: overriding native navigator values is inconsistent.
 *   DSH_WEBREADER_LOCALE   Locale / Accept-Language base (default: zh-CN).
 *   DSH_WEBREADER_GPU      "1" force GPU on, "0" force --disable-gpu (default: auto-detect /dev/dri render node).
 *   DSH_WEBREADER_CDP      Connect to an external browser over CDP instead of launching
 *                         the bundled Chromium, e.g. "http://localhost:9222".
 *   DSH_WEBREADER_MAXURL  Max URL length kept in markdown output (default: 120;
 *                         longer URLs — typically ad/tracking — are dropped).
 *   DSH_WEBREADER_DEBUG    "1" to print debug logs to stderr.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { mkdir, writeFile } from "node:fs/promises";
import { accessSync, readdirSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createJevClassifier, createJevUsageAccumulator, type JevClassifier } from "../shared/jev/runtime.ts";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { fileURLToPath } from "node:url";
import {
  chooseScopeCandidate,
  decideAriaScope,
  type ScopeCandidate,
  type ScopeDecision,
} from "./selection.js";
import { waitForReadableContent, readinessNote } from "./readiness.ts";
import { withConsentTools } from "./consent-frames.ts";
import { CLEAN_CONSENT_SCRIPT } from "./page.ts";

const DEBUG = /^(1|true|yes)$/i.test(process.env.DSH_WEBREADER_DEBUG || "");
function log(...a: unknown[]) {
  if (DEBUG) console.error("[web-reader]", ...a);
}

// ---- environment-driven config -------------------------------------------
// NOTE: we deliberately do NOT spoof a User-Agent by default. Spoofing while the real
// browser reports a different platform (e.g. claiming Windows on a Linux Chrome) creates a
// self-contradictory fingerprint that Cloudflare's challenge rejects outright — verified
// empirically: spoofing alone turns a passing challenge into a failing one. Use
// DSH_WEBREADER_UA only if you genuinely run a browser matching that UA.
const UA = process.env.DSH_WEBREADER_UA?.trim() || "";
const LOCALE = process.env.DSH_WEBREADER_LOCALE || "zh-CN";
// Always headless: no Cloudflare challenge handling, so no real window / Xvfb is needed.
const CDP = process.env.DSH_WEBREADER_CDP?.trim() || "";
const MAX_URL = parseInt(process.env.DSH_WEBREADER_MAXURL || "120", 10);
// Resolve the extension's own directory (works for both local dev installs and
// `pi install` git/npm packages, which land under different paths).
const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = path.join(tmpdir(), "dsh-web-reader");

const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process,AutomationControlled",
  "--disable-infobars",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
];

// GPU: decide dynamically instead of hardcoding --disable-gpu. On Linux only use the GPU
// when a render node is readable/writable by us; otherwise Chromium would waste time
// probing, so software rendering is requested explicitly. Other platforms: let Chromium
// choose. DSH_WEBREADER_GPU=1|0 forces it on/off.
function gpuArgs(): string[] {
  const force = process.env.DSH_WEBREADER_GPU;
  if (force !== undefined) return /^(1|true|yes)$/i.test(force) ? [] : ["--disable-gpu"];
  if (process.platform !== "linux") return [];
  try {
    const nodes = readdirSync("/dev/dri").filter((n) => n.startsWith("renderD"));
    for (const n of nodes) {
      try { accessSync(`/dev/dri/${n}`, fsConstants.R_OK | fsConstants.W_OK); return []; } catch { /* try next */ }
    }
  } catch { /* no /dev/dri */ }
  return ["--disable-gpu"];
}

// Playwright's BUNDLED Chromium only. We deliberately do not fall back to a system
// chrome/msedge: the plugin must work on a machine that has nothing but its own
// dependencies installed.
// ---- browser lifecycle ----------------------------------------------------
interface AnyBrowser {
  newContext(opts?: unknown): Promise<AnyContext>;
  close(): Promise<void>;
  contexts(): AnyContext[];
}
interface AnyContext {
  newPage(): Promise<AnyPage>;
  close(): Promise<void>;
  addInitScript(fn: unknown): Promise<void>;
  newCDPSession?(page: unknown): Promise<{ send(method: string, params?: unknown): Promise<unknown> }>;
}
interface AnyPage {
  goto(url: string, opts?: unknown): Promise<{ status(): number; headers?(): Record<string, string> } | null>;
  waitForLoadState(state: string, opts?: unknown): Promise<void>;
  waitForSelector(sel: string, opts?: unknown): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  ariaSnapshot(opts?: unknown): Promise<string>;
  content(): Promise<string>;
  screenshot(opts?: unknown): Promise<Buffer>;
  evaluate<T>(expression: string): Promise<T>;
  evaluate<T, A = void>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T>;
  url(): string;
  title(): Promise<string>;
  mouse?: {
    move(x: number, y: number, opts?: { steps?: number }): Promise<void>;
    down(): Promise<void>;
    up(): Promise<void>;
  };
  locator(sel: string): {
    first(): { ariaSnapshot(opts?: unknown): Promise<string> };
    nth(index: number): { ariaSnapshot(opts?: unknown): Promise<string> };
  };
  close(): Promise<void>;
}

let browser: AnyBrowser | null = null;
let context: AnyContext | null = null;
let activeChannel = "";
let viaCdp = false;
let opening: Promise<void> | null = null;
// Token for the launch that `opening` currently refers to (see ensureBrowser).
let openingToken: object | null = null;
// Bumped by closeBrowser(). A browser launch that was already in flight when a
// session shut down must not publish its handles afterwards, or the process
// would be orphaned with no reference left to close it.
let generation = 0;
let autoInstallTriggered = false;

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------
/** Milliseconds as "1.2s" / "340ms" — the same shape tool-duration.ts prints. */
function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function triggerBackgroundChromiumInstall() {
  if (autoInstallTriggered) return;
  autoInstallTriggered = true;
  try {
    const cliPath = require.resolve("playwright/cli");
    // NOTE: windowsHide is required on Windows, and `detached` must NOT be used there:
    // detached:true asks Windows for a brand-new console, which overrides windowsHide and
    // pops a visible node.exe window (process.execPath is node.exe) every time this runs.
    // Without `detached` the child still outlives us via unref() + stdio:"ignore".
    const child = spawn(process.execPath, [cliPath, "install", "chromium", "chromium-headless-shell"], {
      cwd: EXT_DIR,
      stdio: "ignore",
      windowsHide: true,
      ...(process.platform === "win32" ? {} : { detached: true }),
    });
    // A missing binary/CWD surfaces as an async 'error' event that a try/catch cannot see;
    // without a listener it becomes an uncaught exception and takes the process down.
    child.on("error", (e) => {
      log("background chromium install could not start:", (e as NodeJS.ErrnoException).code || e.message);
    });
    child.unref();
    log("triggered background Playwright Chromium installation (pid:", child.pid, ")");
  } catch (err) {
    log("failed to trigger background chromium install:", (err as Error).message);
  }
}

function contextOpts() {
  return {
    // Only override the UA when the user explicitly asked for one; otherwise keep the
    // browser's native (self-consistent) user agent.
    ...(UA ? { userAgent: UA } : {}),
    locale: LOCALE,
    // 1280x1536 is deliberate, not arbitrary:
    // - Jev rejects images whose long side exceeds 1536, so the old 1920x1080 viewport
    //   could never be sent as a readiness screenshot.
    // - 1280 wide keeps desktop layouts; 1024 drops most of MDN's ARIA tree
    //   (75KB -> 29KB), and 720 triggers mobile loading pages on Douban/Bilibili.
    // - 1536 tall shows enough of the page to judge blank/skeleton states visually.
    // ARIA extraction at 1280x1536 is byte-for-byte comparable to 1920x1080 on the
    // pages measured (GitHub, Wikipedia, MDN, Douban, BBC, Playwright docs).
    viewport: { width: 1280, height: 1536 },
    javaScriptEnabled: true,
    extraHTTPHeaders: { "Accept-Language": `${LOCALE},${LOCALE.split("-")[0]};q=0.9,en;q=0.8` },
  };
}

async function ensureBrowser(): Promise<AnyContext> {
  if (context) return context;
  if (opening) {
    await opening;
    if (context) return context;
  }
  const myGeneration = generation;
  // Unique token identifying this launch, so the finally block can tell whether
  // `opening` still refers to us and avoid clobbering a newer launch.
  const token = { generation: myGeneration };
  let started: Promise<void>;
  started = (async () => {
    // Launch into locals and publish only at the end: if session_shutdown runs
    // while we are starting up, the half-built browser is closed here instead of
    // being written into the module-level handles.
    let launched: AnyBrowser | null = null;
    let launchedContext: AnyContext | null = null;
    let channel = "";
    let isCdp = false;
    try {
      let chromium: any;
      try {
        ({ chromium } = await import("playwright"));
      } catch {
        throw new Error(
          "Playwright is not installed. Run `npm install` inside " +
            "the dsh-extensions package directory (and `npx playwright install chromium` if needed).",
        );
      }

      if (CDP) {
        log("connecting over CDP:", CDP);
        launched = (await chromium.connectOverCDP(CDP)) as AnyBrowser;
        isCdp = true;
        channel = "cdp";
        launchedContext = launched.contexts()[0] || (await launched.newContext(contextOpts()));
      } else {
        try {
          log("launching bundled chromium, headless: true");
          launched = (await chromium.launch({
            headless: true,
            args: [...LAUNCH_ARGS, ...gpuArgs()],
          })) as AnyBrowser;
          channel = "chromium";
        } catch (e) {
          const msg = (e as Error).message || String(e);
          if (/Executable doesn't exist|browserType\.launch.*chromium|browser was not found|Looks like Playwright was installed/i.test(msg)) {
            triggerBackgroundChromiumInstall();
            throw new Error(
              "The bundled Chromium is not installed. Run:\n" +
                `  cd ${EXT_DIR} && npx playwright install chromium\n` +
                `\nOriginal error: ${msg}`,
            );
          }
          throw e;
        }
        launchedContext = await launched.newContext(contextOpts());
      }

      // No stealth patches by default: overriding navigator.plugins / languages / WebGL
      // on a real browser makes the fingerprint internally inconsistent, which is itself
      // a strong bot signal (and measurably breaks the Cloudflare challenge). Set
      // DSH_WEBREADER_STEALTH=1 to opt back in for cases that need it.
      if (/^(1|true|yes)$/i.test(process.env.DSH_WEBREADER_STEALTH || "")) {
        await launchedContext!.addInitScript(stealth);
      }

      if (myGeneration !== generation) {
        // The session that asked for this browser is gone; close it rather than
        // leaking an unreferenced Chromium process.
        await launched.close().catch(() => {});
        return;
      }

      browser = launched;
      context = launchedContext;
      activeChannel = channel;
      viaCdp = isCdp;
      log("ready. channel:", activeChannel, "cdp:", viaCdp);
    } finally {
      // Only clear our own marker: closeBrowser() may have replaced it with a
      // newer launch's promise, which must stay awaitable by other callers.
      if (openingToken === token) {
        opening = null;
        openingToken = null;
      }
    }
  })();
  opening = started;
  openingToken = token;
  await started;
  if (!context) throw new Error("Failed to start browser");
  return context;
}

async function closeBrowser() {
  // Invalidate any in-flight launch BEFORE awaiting it: the starter sees the
  // generation change and closes its own browser instead of publishing it.
  generation += 1;
  const b = browser;
  const inFlight = opening;
  context = null;
  browser = null;
  activeChannel = "";
  viaCdp = false;
  opening = null;
  openingToken = null;
  if (inFlight) {
    try {
      await inFlight;
    } catch {
      /* the launch failed; nothing to close */
    }
  }
  if (b) {
    try {
      await b.close();
    } catch {
      /* ignore */
    }
  }
}

// ---- per-fetch logic ------------------------------------------------------
interface FetchParams {
  url: string;
  format: "markdown" | "text" | "aria" | "html";
  selector?: string;
  autoSelector?: boolean;
  waitUntil: "load" | "domcontentloaded" | "networkidle";
  waitSelector?: string;
  extraWaitMs?: number;
  timeoutMs?: number;
  screenshot?: boolean;
  fullPage?: boolean;
  inlineImage?: boolean;
}

async function fetchPage(p: FetchParams, signal?: AbortSignal, jevService?: JevClassifier) {
  const t0 = Date.now();
  const mark = () => Date.now() - t0;
  // Timing ensureBrowser() itself is what distinguishes a cold launch (seconds) from a
  // warm no-op (~0ms); there is no need to instrument the launch path for that.
  const ctx = await ensureBrowser();
  const browserMs = mark();
  const timeout = p.timeoutMs ?? 45000;
  const page = await ctx.newPage();
  const afterNewPageMs = mark();

  const onAbort = () => {
    try {
      void page.close();
    } catch {
      /* ignore */
    }
  };
  if (signal) {
    if (signal.aborted) {
      await page.close().catch(() => {});
      throw new Error("aborted");
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  let status: number | null = null;
  try {
    // Navigate with waitUntil "commit", NOT domcontentloaded.
    //
    // `domcontentloaded` was the default and it is not a completion signal we can rely on:
    // a site that keeps long-lived subresources open (openai.com: ~100 `_next/static` chunks
    // that never finish) never fires DCL at all in some runs, so goto burned the whole 45s
    // timeout and the read returned "incomplete". Worse, it was flaky rather than slow —
    // measured on openai.com, the SAME config timed out 2/6 runs and returned in ~2.3s on the
    // other 4. Reproduced independent of the plugin: a bare Playwright goto behaved identically,
    // so the browser is not the variable.
    //
    // "commit" returns as soon as the navigation response is received, which is the only thing
    // goto can guarantee here; the real readiness signal is `waitForReadableContent` below,
    // which short-circuits as soon as substantive content is present. `load`/`networkidle`
    // stay bounded so a stalled page costs seconds, not the whole budget.
    const navTimeout = Math.min(timeout, 20000);
    let resp: { status(): number; headers?(): Record<string, string> } | null = null;
    try {
      resp = await page.goto(p.url, { waitUntil: "commit", timeout: navTimeout });
    } catch (e) {
      log("goto threw (continuing):", (e as Error).message);
    }
    if (!resp) {
      // goto can leave the page without a document (e.g. a navigation that never committed).
      // Do not silently report an empty read; a bounded second attempt at least confirms the
      // URL is unreachable within a deterministic budget.
      try {
        resp = await page.goto(p.url, { waitUntil: "commit", timeout: Math.min(navTimeout, 10000) });
      } catch (e) {
        log("goto retry threw:", (e as Error).message);
      }
    }
    if (resp) {
      status = resp.status();
    }

    // 1. Bounded settle wait. The DOM is usually already interactive after commit; these are
    // ceilings for the slow case, and their expiry is expected, not an error.
    if (p.waitUntil === "networkidle") {
      await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 8000) }).catch(() => {});
    } else {
      // A short ceiling on purpose: when `load` never fires (openai.com), this used to burn 5s
      // on every read. `waitForReadableContent` polls the DOM and returns as soon as real
      // content exists, so it — not this — is the readiness gate. One second is enough for
      // the initial document/shell; waiting longer mainly penalizes heavy SPA pages such as
      // YouTube without improving the final extraction.
      await page.waitForLoadState("load", { timeout: Math.min(timeout, 1000) }).catch(() => {});
    }
    const afterLoadStateMs = mark();

    // 2. Custom wait selector if provided
    if (p.waitSelector) await page.waitForSelector(p.waitSelector, { timeout }).catch(() => {});

    // 3. Dynamic SPA hydration, code block formatting, lazy content auto-wait, & table span annotation
    try {
      await page.evaluate(async () => {
        // Annotate table colspan/rowspan attributes with explicit semantic tags
        try {
          const tables = document.querySelectorAll("table");
          for (const table of tables) {
            const rows = table.querySelectorAll("tr");
            for (const tr of rows) {
              const cells = tr.querySelectorAll("th, td");
              for (const cell of cells) {
                const colSpan = cell.getAttribute("colspan")
                  ? parseInt(cell.getAttribute("colspan")!, 10)
                  : 1;
                const rowSpan = cell.getAttribute("rowspan")
                  ? parseInt(cell.getAttribute("rowspan")!, 10)
                  : 1;
                const badges: string[] = [];
                if (colSpan > 1) badges.push(`colspan=${colSpan}`);
                if (rowSpan > 1) badges.push(`rowspan=${rowSpan}`);
                if (badges.length > 0) {
                  const tag = `[${badges.join(", ")}] `;
                  const textNode = document.createTextNode(tag);
                  cell.insertBefore(textNode, cell.firstChild);
                }
              }
            }
          }
        } catch {
          /* ignore */
        }

        // Preserve newlines in multi-line <pre> / <code> blocks for ARIA snapshot
        try {
          const pres = document.querySelectorAll("pre, code");
          for (const pre of pres) {
            const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
              if (node.nodeValue && node.nodeValue.includes("\n")) {
                node.nodeValue = node.nodeValue.replace(/\n/g, " __PI_NL__ ");
              }
            }
          }
        } catch {
          /* ignore */
        }

        // Trigger lazy loading by smooth gentle scrolling
        const scrollH = document.body?.scrollHeight || 0;
        if (scrollH > 1000) {
          window.scrollTo(0, Math.min(scrollH, 2000));
          await new Promise((r) => setTimeout(r, 100));
          window.scrollTo(0, 0);
        }
      });
    } catch {
      /* ignore evaluate errors on unusual pages */
    }

    // 4. Extra wait (at least small pause for hydration if not specified)
    const extraWait = p.extraWaitMs ?? 400;
    if (extraWait > 0) await page.waitForTimeout(extraWait).catch(() => {});
    const loadVerdict = await waitForReadableContent(withConsentTools(page as any), p.url, jevService, signal);
    // Only the temporary page is changed. Keep explicit selectors and blocked consent evidence intact.
    if (!p.selector && loadVerdict.blocked !== "consent_wall") await page.evaluate(CLEAN_CONSENT_SCRIPT).catch(() => {});

    // Content extraction = Playwright ARIA accessibility snapshot (same source as
    // playwright-cli). Hidden/aria-hidden/hover-only nodes are excluded by design.
    let aria = "";
    let effectiveSelector = p.selector;
    let selection: ScopeDecision | undefined;
    let candidate: ScopeCandidate | undefined;

    // Take the full snapshot as a completeness baseline. Automatic scoping is accepted only
    // when it retains a meaningful share of this tree; this prevents a review card, resource
    // card, or first feed item from being mistaken for the whole page.
    let fullAria = "";
    try {
      fullAria = await page.ariaSnapshot({ timeout: Math.min(timeout, 10000) });
    } catch (e) {
      log("full-page ariaSnapshot failed:", (e as Error).message);
    }

    // Auto-detect the broadest substantive content container. Inspect every matching element
    // instead of document.querySelector(...)/locator.first(), which loses multi-article feeds.
    if (!effectiveSelector && p.autoSelector !== false) {
      try {
        const selectors = [
          "#main-content",
          "main",
          "[role=\"main\"]",
          "article.markdown",
          "[class*=\"prose-doc\"]",
          "[class*=\"markdown-body\"]",
          "[class*=\"doc-content\"]",
          ".prose",
          "main article",
          ".content-container",
          ".main-content",
          "article",
        ];
        const candidates = await page.evaluate((sels: string[]) => {
          const found: ScopeCandidate[] = [];
          sels.forEach((selector, priority) => {
            const elements = [...document.querySelectorAll<HTMLElement>(selector)];
            const lengths = elements.map((element) => (element.innerText || "").trim().length);
            const substantiveMatches = lengths.filter((length) => length > 200).length;
            elements.forEach((element, index) => {
              found.push({ selector, index, textLength: lengths[index], priority, substantiveMatches });
            });
          });
          return found;
        }, selectors);
        candidate = chooseScopeCandidate(candidates);
        if (candidate) {
          effectiveSelector = candidate.selector;
          log("auto-detected content candidate:", candidate);
        }
      } catch (e) {
        log("auto-detection threw (falling back to full page):", (e as Error).message);
      }
    }

    if (effectiveSelector) {
      try {
        const locator = page.locator(effectiveSelector);
        const scopedAria = p.selector
          ? await locator.first().ariaSnapshot({ timeout: Math.min(timeout, 4000) })
          : await locator.nth(candidate?.index ?? 0).ariaSnapshot({ timeout: Math.min(timeout, 4000) });

        // Explicit user selectors are authoritative. Automatic selectors must pass the
        // coverage guard before they are allowed to discard the full-page snapshot.
        if (p.selector) {
          aria = scopedAria;
        } else {
          selection = decideAriaScope(fullAria, scopedAria, candidate);
          if (selection.useScoped) {
            aria = scopedAria;
          } else {
            aria = fullAria;
            log("rejected auto scope:", selection.reason, selection.coverage);
            effectiveSelector = undefined;
          }
        }
      } catch (e) {
        log("locator ariaSnapshot failed, falling back to full page:", (e as Error).message);
      }
    }
    if (!aria || !aria.trim()) aria = fullAria;
    if (!aria || !aria.trim()) {
      // Last resort, and still a hard failure on purpose: an extraction failure must surface as
      // an error rather than being papered over with a lower-fidelity fallback (that contract is
      // pinned by tests/web-reader-jev-usage.test.ts). Only the message is improved here, because
      // a bare "ariaSnapshot: Timeout 10000ms exceeded" gives no hint that the DOM never settled.
      try {
        aria = await page.ariaSnapshot({ timeout: Math.min(timeout, 10000) });
      } catch (e) {
        throw new Error(
          `content extraction failed: ${(e as Error).message} ` +
            `(the DOM did not produce an accessibility snapshot; the page may still be loading ` +
            `subresources that never settle — see URL=${p.url})`,
        );
      }
    }

    let html: string | undefined;
    if (p.format === "html") {
      try {
        html = await page.content();
      } catch {
        /* ignore */
      }
    }

    let screenshotB64: string | null = null;
    let screenshotPath: string | null = null;
    if (p.screenshot || p.inlineImage) {
      const buf = await page.screenshot({ fullPage: !!p.fullPage, type: "png", timeout });
      screenshotB64 = buf.toString("base64");
      try {
        await mkdir(SHOT_DIR, { recursive: true });
        screenshotPath = path.join(
          SHOT_DIR,
          `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
        );
        await writeFile(screenshotPath, buf);
      } catch (e) {
        log("save screenshot failed:", (e as Error).message);
      }
    }

    const title = await page.title().catch(() => "");
    const totalMs = mark();
    return {
      status,
      title,
      timing: {
        totalMs,
        // Cold launch dominates everything else; report it only when it actually happened.
        browserMs: browserMs > 50 ? browserMs : undefined,
        newPageMs: afterNewPageMs - browserMs,
        navigateMs: afterLoadStateMs - afterNewPageMs,
        extractMs: totalMs - afterLoadStateMs,
      },
      url: page.url(),
      aria,
      html,
      effectiveSelector,
      selection,
      screenshot: screenshotB64,
      screenshotPath,
      loadVerdict,
    };
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    try {
      await page.close();
    } catch {
      /* ignore */
    }
  }
}

// ==========================================================================
// ARIA YAML parser + Markdown / text renderer (runs in Node, not the browser)
// Format produced by Playwright's page.ariaSnapshot():
//   - role ["accessible name"] [flags like [level=3]]:
//     - /url: <url>
//     - text: <raw text>
//     - child role ...
// ==========================================================================

interface AriaNode {
  role: string;
  name: string;
  level: number;
  url?: string;
  children: AriaNode[];
}

function parseAria(yaml: string): AriaNode {
  const root: AriaNode = { role: "root", name: "", level: 0, children: [] };
  const stack: { indent: number; node: AriaNode }[] = [{ indent: -1, node: root }];
  for (const line of yaml.split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^(\s*)-\s+(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    let rest = m[2].trim();

    if (rest.startsWith("/url:")) {
      const parent = stack[stack.length - 1].node;
      if (parent) {
        let u = rest.slice(5).trim();
        if (
          (u.startsWith("\"") && u.endsWith("\"")) ||
          (u.startsWith("'") && u.endsWith("'"))
        ) {
          u = u.slice(1, -1);
        }
        parent.url = u;
      }
      continue;
    }

    // Strip wrapping quotes and trailing colons that YAML emitters produce for lines with special chars
    if (rest.endsWith(":")) rest = rest.slice(0, -1).trim();
    if (
      (rest.startsWith("'") && rest.endsWith("'")) ||
      (rest.startsWith("\"") && rest.endsWith("\""))
    ) {
      rest = rest.slice(1, -1).trim();
    }
    if (rest.endsWith(":")) rest = rest.slice(0, -1).trim();

    let node: AriaNode;
    if (rest.startsWith("text:")) {
      let t = rest.slice(5).trim();
      if (
        (t.startsWith("\"") && t.endsWith("\"")) ||
        (t.startsWith("'") && t.endsWith("'"))
      ) {
        t = t.slice(1, -1);
      }
      node = { role: "text", name: t, level: 0, children: [] };
    } else if (rest.startsWith("code:")) {
      let t = rest.slice(5).trim();
      if (
        (t.startsWith("\"") && t.endsWith("\"")) ||
        (t.startsWith("'") && t.endsWith("'"))
      ) {
        t = t.slice(1, -1);
      }
      node = { role: "code", name: t, level: 0, children: [] };
    } else {
      const match = rest.match(/^([a-zA-Z0-9_-]+)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$/);
      if (!match) {
        node = { role: rest, name: "", level: 0, children: [] };
      } else {
        const role = match[1];
        let name = match[2] != null ? match[2] : "";
        const tail = match[3] || "";
        const lvlM = tail.match(/\[level=(\d+)\]/);
        const level = lvlM ? parseInt(lvlM[1], 10) : 0;
        const colonIdx = tail.indexOf(":");
        if (colonIdx !== -1) {
          let inline = tail.slice(colonIdx + 1).trim();
          if (
            (inline.startsWith("\"") && inline.endsWith("\"")) ||
            (inline.startsWith("'") && inline.endsWith("'"))
          ) {
            inline = inline.slice(1, -1);
          }
          if (inline) name = name ? `${name} ${inline}` : inline;
        }
        node = { role, name, level, children: [] };
      }
    }

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ indent, node });
  }
  return root;
}

const CONTAINER = new Set([
  "root", "generic", "main", "section", "article", "group", "region", "navigation",
  "banner", "contentinfo", "complementary", "figure", "figcaption", "form",
  "application", "document", "presentation", "none", "toolbar", "rowgroup",
]);
const SKIP = new Set(["img", "graphic"]);

function inlineText(node: AriaNode): string {
  let s = node.name || "";
  for (const c of node.children) {
    if (c.role === "text" || c.role === "code") {
      s = s ? `${s} ${c.name}` : c.name;
    } else if (c.role === "link") {
      const t = c.name || inlineText(c);
      s = s ? `${s} ${t}` : t;
    } else if (!SKIP.has(c.role) && !c.url) {
      const t = inlineText(c);
      if (t) s = s ? `${s} ${t}` : t;
    }
  }
  return s;
}

function linkText(url: string | undefined, text: string): string {
  if (url && url.length > 0 && url.length <= MAX_URL) return `[${text}](${url})`;
  return text;
}

function renderTable(tableNode: AriaNode, out: string[]) {
  const rows: AriaNode[] = [];
  function collectRows(n: AriaNode) {
    if (n.role === "row") {
      rows.push(n);
    } else {
      for (const c of n.children) collectRows(c);
    }
  }
  collectRows(tableNode);
  if (rows.length === 0) return;

  const rawRows: { text: string; colspan: number; rowspan: number }[][] = [];
  for (const row of rows) {
    const cells: { text: string; colspan: number; rowspan: number }[] = [];
    for (const c of row.children) {
      if (c.role === "cell" || c.role === "columnheader" || c.role === "rowheader") {
        let cellText = (c.name || inlineText(c)).trim();
        cellText = cellText.replace(/\|/g, "\\|").replace(/\n+/g, " ");

        let colspan = 1;
        let rowspan = 1;
        const colM = cellText.match(/\[(?:.*?\b)?colspan=(\d+)(?:.*?)?\]/i);
        if (colM) colspan = Math.max(1, parseInt(colM[1], 10));
        const rowM = cellText.match(/\[(?:.*?\b)?rowspan=(\d+)(?:.*?)?\]/i);
        if (rowM) rowspan = Math.max(1, parseInt(rowM[1], 10));

        cells.push({ text: cellText, colspan, rowspan });
      }
    }
    if (cells.length > 0) {
      rawRows.push(cells);
    }
  }
  if (rawRows.length === 0) return;

  // Build a true 2D matrix accounting for spans
  const grid: (string | undefined)[][] = [];
  for (let r = 0; r < rawRows.length; r++) {
    if (!grid[r]) grid[r] = [];
    const row = rawRows[r];
    let colIndex = 0;

    for (const cell of row) {
      while (grid[r][colIndex] !== undefined) {
        colIndex++;
      }

      grid[r][colIndex] = cell.text;

      // Fill spanned grid cells with merge continuation indicators
      for (let dr = 0; dr < cell.rowspan; dr++) {
        for (let dc = 0; dc < cell.colspan; dc++) {
          if (dr === 0 && dc === 0) continue;
          const tr = r + dr;
          const tc = colIndex + dc;
          if (!grid[tr]) grid[tr] = [];
          // '»' denotes merged from left, '«' denotes merged from above
          grid[tr][tc] = dr === 0 ? "»" : "«";
        }
      }

      colIndex += cell.colspan;
    }
  }

  let maxCols = 0;
  for (const row of grid) {
    if (row && row.length > maxCols) maxCols = row.length;
  }
  if (maxCols === 0) return;

  out.push("\n\n");
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    const cellTexts: string[] = [];
    for (let c = 0; c < maxCols; c++) {
      cellTexts.push(row[c] !== undefined ? row[c]! : "");
    }
    out.push("| " + cellTexts.join(" | ") + " |\n");
    if (r === 0) {
      out.push("| " + cellTexts.map(() => "---").join(" | ") + " |\n");
    }
  }
  out.push("\n");
}

function renderMarkdown(node: AriaNode, out: string[], listDepth: number) {
  for (const n of node.children) {
    switch (n.role) {
      case "heading": {
        const lvl = n.level > 0 && n.level <= 6 ? n.level : 2;
        out.push("\n\n" + "#".repeat(lvl) + " " + (n.name || inlineText(n)).trim() + "\n\n");
        break;
      }
      case "link": {
        const txt = (n.name || inlineText(n)).trim();
        if (txt) out.push(linkText(n.url, txt) + " ");
        for (const c of n.children)
          if (c.role !== "text" && c.role !== "code" && !c.url && !SKIP.has(c.role))
            renderMarkdown({ role: "x", name: "", level: 0, children: [c] }, out, listDepth);
        break;
      }
      case "list":
        renderMarkdown(n, out, listDepth);
        out.push("\n");
        break;
      case "listitem": {
        const pad = "  ".repeat(listDepth);
        const nested: AriaNode[] = [];
        const bodyParts: string[] = [];
        for (const c of n.children) {
          if (c.role === "list") nested.push(c);
          else if ((c.role === "text" || c.role === "code") && c.name.trim()) {
            bodyParts.push(c.role === "code" ? `\`${c.name.trim()}\`` : c.name.trim());
          } else {
            const t = (c.name || inlineText(c)).trim();
            if (t) bodyParts.push(c.url ? linkText(c.url, t) : t);
          }
        }
        const body = bodyParts.join(" ").trim();
        if (body) out.push(`\n${pad}- ${body}`);
        else if (nested.length) out.push(`\n${pad}-`);
        for (const c of nested) renderMarkdown(c, out, listDepth + 1);
        break;
      }
      case "paragraph": {
        const body = inlineText(n).trim();
        if (body) out.push("\n" + body + "\n");
        break;
      }
      case "table":
        renderTable(n, out);
        break;
      case "code": {
        let txt = n.name.trim();
        if (txt) {
          if (txt.includes("__PI_NL__") || txt.includes("\n")) {
            const restored = txt.replace(/\s*__PI_NL__\s*/g, "\n").trim();
            out.push("\n\n```\n" + restored + "\n```\n\n");
          } else {
            out.push("`" + txt + "` ");
          }
        }
        break;
      }
      case "text":
        if (n.name.trim()) out.push(n.name.trim() + " ");
        break;
      case "textbox":
        if (n.name.trim()) out.push(`[输入框:${n.name.trim()}] `);
        break;
      case "button":
        if (n.name.trim()) out.push(`[按钮:${n.name.trim()}] `);
        break;
      case "separator":
        out.push("\n\n---\n\n");
        break;
      default:
        if (SKIP.has(n.role)) break;
        if (CONTAINER.has(n.role)) {
          renderMarkdown(n, out, listDepth);
        } else {
          if (n.name.trim()) out.push(n.name.trim() + " ");
          renderMarkdown(n, out, listDepth);
        }
    }
  }
}

function renderText(node: AriaNode, out: string[]) {
  for (const n of node.children) {
    switch (n.role) {
      case "heading":
      case "paragraph":
      case "text":
      case "code": {
        const t = (n.name || inlineText(n)).trim();
        if (t) out.push(t + "\n");
        for (const c of n.children) renderText({ role: "x", name: "", level: 0, children: [c] }, out);
        break;
      }
      case "link": {
        const t = (n.name || inlineText(n)).trim();
        if (t) out.push(t + " ");
        for (const c of n.children) renderText({ role: "x", name: "", level: 0, children: [c] }, out);
        break;
      }
      case "listitem": {
        const t = (n.name || inlineText(n)).trim();
        if (t) out.push("- " + t + "\n");
        for (const c of n.children) renderText({ role: "x", name: "", level: 0, children: [c] }, out);
        break;
      }
      case "textbox":
      case "button":
        break;
      default:
        if (SKIP.has(n.role)) break;
        for (const c of n.children) renderText({ role: "x", name: "", level: 0, children: [c] }, out);
    }
  }
}

function ariaToMarkdown(yaml: string): string {
  const out: string[] = [];
  renderMarkdown(parseAria(yaml), out, 0);
  return out
    .join("")
    .replace(/\s*__PI_NL__\s*/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ {2,}/g, " ")
    .trim();
}

function ariaToText(yaml: string): string {
  const out: string[] = [];
  renderText(parseAria(yaml), out);
  return out
    .join("")
    .replace(/\s*__PI_NL__\s*/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---- browser-side: stealth init script (self-contained) -------------------
function stealth() {
  try {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined, configurable: true });
  } catch {}
  try {
    Object.defineProperty(navigator, "languages", {
      get: () => ["zh-CN", "zh", "en-US", "en"],
      configurable: true,
    });
  } catch {}
  try {
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5].map((i) => ({ name: "Plugin " + i, filename: "np" + i + ".dll" })),
      configurable: true,
    });
  } catch {}
  try {
    const w = window as any;
    w.chrome = w.chrome || { runtime: {}, app: {}, csi: () => {}, loadTimes: () => {} };
  } catch {}
  try {
    const orig = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (p: any): any =>
      p && p.name === "notifications"
        ? Promise.resolve({ state: (Notification as any).permission })
        : orig(p);
  } catch {}
  try {
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (p: number) {
      if (p === 37445) return "Intel Inc.";
      if (p === 37446) return "Intel Iris OpenGL Engine";
      return getParameter.call(this, p);
    };
  } catch {}
}

// ---- extension factory ----------------------------------------------------
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    try {
      const active = pi.getActiveTools();
      if (active.length > 0 && !active.includes("web_reader"))
        pi.setActiveTools([...active, "web_reader"]);
    } catch {
      /* ignore */
    }
    // Eagerly pre-warm the browser in the background to eliminate cold-start latency
    ensureBrowser().catch((e) => {
      log("pre-warm browser failed:", (e as Error).message);
    });
  });

  pi.on("session_shutdown", async () => {
    await closeBrowser();
  });

  pi.registerTool({
    name: "web_reader",
    label: "Web Reader",
    description:
      "Fetch and fully render web page content with a real headless browser (handles " +
      "JavaScript / single-page apps, dynamic hydration, and bot-blocking pages are reported, not bypassed). Content " +
      "is extracted from Playwright's ARIA accessibility snapshot and Jev semantic load verification — so " +
      "hidden/hover-only UI is excluded and the output is clean, readable Markdown. Age/content-preference, login, consent and error pages are classified separately from render readiness; a blocked result is not article content.",
    promptSnippet: "Real-browser web reader; clean Markdown via ARIA snapshot and Jev semantic load verification",
    promptGuidelines: [
      "Use web_reader to fetch and read web page content, including JavaScript-heavy SPAs, dynamic sites, and documentation.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Absolute URL to render (http/https; protocol auto-added)." }),
      format: Type.Optional(StringEnum(["markdown", "text", "aria", "html"] as const)),
      selector: Type.Optional(
        Type.String({
          description: "Optional CSS selector: snapshot only that subtree (e.g. 'main', 'article', '.content'). By default, intelligent main content auto-detection is used.",
        }),
      ),
      autoSelector: Type.Optional(
        Type.Boolean({
          description: "Whether to automatically detect main content container (defaults to true). Set false to snapshot whole page.",
        }),
      ),
      waitUntil: Type.Optional(StringEnum(["load", "domcontentloaded", "networkidle"] as const)),
      waitSelector: Type.Optional(
        Type.String({ description: "Optional CSS selector to wait for before extracting." }),
      ),
      extraWaitMs: Type.Optional(
        Type.Number({ description: "Extra fixed wait (ms) after network idle, for lazy content (default: 400ms)." }),
      ),
      timeoutMs: Type.Optional(Type.Number({ description: "Navigation timeout in ms (default 45000)." })),
      screenshot: Type.Optional(
        Type.Boolean({ description: "Capture a PNG screenshot (saved to OS temp dir; path returned)." }),
      ),
      inlineImage: Type.Optional(
        Type.Boolean({
          description: "Also return the screenshot as an inline base64 image block (for multimodal models). Default false — only the file path is returned.",
        }),
      ),
      fullPage: Type.Optional(Type.Boolean({ description: "Full-page screenshot (default viewport only)." })),
      maxChars: Type.Optional(
        Type.Number({ description: "Max characters of returned text/markdown (default 60000)." }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }], details: {} };

      let url = (params as { url: string }).url?.trim();
      if (!url) return { content: [{ type: "text", text: "Error: `url` is required." }], isError: true, details: {} };
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;

      const p = params as FetchParams;
      const format = (p.format ?? "markdown") as FetchParams["format"];
      p.url = url;
      p.format = format;
      p.waitUntil = (p.waitUntil ?? "domcontentloaded") as FetchParams["waitUntil"];

      onUpdate?.({ content: [{ type: "text", text: `Rendering ${url} …` }], details: {} });

      const jevUsage = createJevUsageAccumulator();
      const jev = createJevClassifier(ctx, jevUsage.add);
      let result;
      try {
        result = await fetchPage(p, signal, jev);
      } catch (e) {
        const msg = (e as Error).message || String(e);
        if (/Executable doesn't exist|browserType\.launch.*chromium|browser was not found|Looks like Playwright was installed/i.test(msg)) {
          return {
            content: [
              {
                type: "text",
                text:
                  "Browser binary not found. The Playwright library was installed, but the bundled Chromium " +
                  "was NOT (npm skips the playwright postinstall script that downloads it). Fix it by running " +
                  "ONE of these from this extension's directory:\n" +
                  "  cd " + EXT_DIR + " && npx playwright install chromium\n" +
                  "...or install a real Chrome/Edge on the system (preferred for anti-detection).\n\n" +
                  "Original error: " + msg,
              },
            ],
            isError: true,
            details: {},
            usage: jevUsage.usage,
          };
        }
        return { content: [{ type: "text", text: `Error rendering page: ${msg}` }], isError: true, details: {}, usage: jevUsage.usage };
      }

      let body = "";
      if (format === "aria") body = result.aria || "";
      else if (format === "html") body = result.html || "";
      else if (format === "text") body = ariaToText(result.aria || "");
      else body = ariaToMarkdown(result.aria || "");

      if (!body.trim() && result.aria) body = result.aria;

      const maxChars = (params as { maxChars?: number }).maxChars ?? 60000;
      let truncated = false;
      if (body.length > maxChars) {
        body = body.slice(0, maxChars);
        truncated = true;
      }

      const hasSpans = body.includes("[colspan=") || body.includes("[rowspan=") || body.includes("»") || body.includes("«");
      const spanLegend = hasSpans
        ? "Note: Tables contain merged cells annotated with [colspan=N]/[rowspan=N], '»' (horizontal continuation), and '«' (vertical continuation).\n"
        : "";

      const selectionNote = result.selection && !result.selection.useScoped
        ? result.selection.reason === "low-coverage"
          ? `  [full-page fallback: ${result.selection.candidate?.selector ?? "candidate"} covered ${Math.round((result.selection.coverage ?? 0) * 100)}%]`
          : `  [full-page fallback: ${result.selection.reason}]`
        : "";
      const jevNote = result.loadVerdict?.jevScore !== undefined || result.loadVerdict?.visualScore !== undefined
        ? `Jev Score: ${result.loadVerdict?.jevScore !== undefined ? result.loadVerdict.jevScore.toFixed(2) : "-"}${result.loadVerdict?.fallback ? " (fallback)" : ""}` +
          (result.loadVerdict?.visualScore !== undefined ? `  |  Visual Jev: ${result.loadVerdict.visualScore.toFixed(2)}` : "") + "\n"
        : "";
      // Mirror the Jev Score line: the per-phase breakdown is what makes a slow read
      // diagnosable (cold launch vs navigation vs a challenge that never resolved).
      const t = result.timing;
      const timingNote = t
        ? `Elapsed: ${fmtMs(t.totalMs)}` +
          (t.browserMs !== undefined ? ` (browser launch ${fmtMs(t.browserMs)})` : "") +
          ` — nav ${fmtMs(t.navigateMs)}, extract ${fmtMs(t.extractMs)}\n`
        : "";
      const header =
        `URL: ${result.url}\n` +
        `Title: ${result.title}\n` +
        `HTTP: ${result.status ?? "?"}\n` +
        `Browser: ${activeChannel}${viaCdp ? " (cdp)" : ""}${result.effectiveSelector ? `  [scope: ${result.effectiveSelector}]` : ""}${selectionNote}${truncated ? "  [truncated]" : ""}\n` +
        readinessNote(result.loadVerdict) +
        jevNote +
        timingNote +
        (result.screenshotPath ? `Screenshot: ${result.screenshotPath}\n` : "") +
        spanLegend +
        `\n`;

      const content: any[] = [
        { type: "text", text: header + body },
      ];
      // Inline base64 is opt-in (bloats the session and is useless for non-vision models).
      // By default only the file path above is returned; feed it to analyze_image.
      if (p.inlineImage && result.screenshot) {
        content.push({
          type: "image",
          data: result.screenshot,
          mimeType: "image/png",
        });
      }

      return {
        content,
        usage: jevUsage.usage,
        isError: !!result.loadVerdict.blocked,
        details: {
          url: result.url,
          title: result.title,
          status: result.status,
          browser: activeChannel,
          jevScore: result.loadVerdict?.jevScore,
          visualScore: result.loadVerdict?.visualScore,
          pageKind: result.loadVerdict.pageKind,
          blocked: result.loadVerdict.blocked,
          incomplete: result.loadVerdict.incomplete,
          verdicts: result.loadVerdict.verdicts,
          visualVerdicts: result.loadVerdict?.visualVerdicts,
          decisionFallback: result.loadVerdict.fallback,
          durationMs: result.timing?.totalMs,
          timing: result.timing,
          truncated,
          format,
          ariaBytes: result.aria?.length ?? 0,
          selection: result.selection,
          screenshotPath: result.screenshotPath,
        },
      };
    },
  });
}
