import test from "node:test";
import assert from "node:assert/strict";

const { readinessInput, visualReadinessInput, waitForReadableContent, decision, judge } = await import(
  "../lib/web-reader.js"
);

const sample = {
  title: "Example",
  text: "A sufficiently long article excerpt that should count as readable content.",
  textLength: 420,
  contentEvidence: true,
  listEvidence: false,
  pendingContent: false,
  consentText: "",
};
const weak = { ...sample, textLength: 40, contentEvidence: false, pendingContent: true, text: "Loading" };

const QUESTION_IDS = ["main_content_present", "still_loading", "consent_only", "consent_overlay_blocking", "login_or_paywall", "age_or_content_gate", "bot_check", "error_page"];

/** 构造一个完整的 Noul 答案集；overrides 只改指定问题。 */
const answers = (overrides = {}) => ({
  answers: Object.fromEntries(
    QUESTION_IDS.map((id) => [id, { type: "bool", probability: { main_content_present: 0.02, still_loading: 0.02, consent_only: 0.02, consent_overlay_blocking: 0.02, login_or_paywall: 0.02, age_or_content_gate: 0.02, bot_check: 0.02, error_page: 0.02, ...overrides }[id] }]),
  ),
});
const READY = { main_content_present: 0.97, still_loading: 0.03 };

function makePage({ current = sample, screenshot = true, failScreenshot = false, consentTools = null } = {}) {
  const calls = { screenshots: 0, scans: 0 };
  let clock = 0;
  const page = {
    calls,
    now: () => clock,
    async evaluate(expression) {
      const text = String(expression);
      if (text.includes("data-yu-overlay")) calls.scans++;
      if (text.includes("contentEvidence")) return typeof current === "function" ? current() : current;
      return false; // consent dismissal
    },
    async waitForTimeout(ms) { clock += ms; },
  };
  if (consentTools) Object.assign(page, consentTools);
  if (screenshot) {
    page.screenshot = async () => {
      calls.screenshots++;
      if (failScreenshot) throw new Error("screenshot failed");
      return new Uint8Array(2000);
    };
  }
  return page;
}
const run = (page, jev) => waitForReadableContent(page, "https://example.com", jev, undefined, page.now);

test("readiness requests are atomic Noul questions with complete instructions", () => {
  for (const input of [readinessInput("https://example.com", sample), visualReadinessInput("https://example.com", sample)]) {
    assert.deepEqual(Object.keys(input.questions).sort(), [...QUESTION_IDS].sort());
    for (const question of Object.values(input.questions)) {
      assert.equal(question.type, "noul");
      assert.ok(question.instructions.length > 40, "the question id is never sent, so the instructions must stand alone");
    }
  }
});

test("readiness requests carry list and video evidence and tell Jev to ignore consent overlays", () => {
  const input = visualReadinessInput("https://example.com", { ...sample, contentEvidence: false, listEvidence: true, mediaEvidence: true });
  assert.ok(input.state.observations.some((line) => line.includes("link-dense list")));
  assert.ok(input.state.observations.some((line) => line.includes("video player")));
  assert.ok(input.state.observations.some((line) => line.includes("screenshot")));
  assert.match(input.questions.main_content_present.instructions, /consent banners?, dialogs and dimmed backdrops are NOT the content/i);
  assert.match(input.questions.still_loading.instructions, /Ignore consent banners/i);
  assert.ok(!readinessInput("https://example.com", sample).state.observations.some((line) => line.includes("attached PNG")));
});

test("judge uses the 0.7 / 0.3 thresholds and leaves the middle band waiting", () => {
  const verdict = (overrides) => judge(decision(answers(overrides)));
  assert.equal(verdict(READY), "ready");
  assert.equal(verdict({ main_content_present: 0.69, still_loading: 0.03 }), "wait");
  assert.equal(verdict({ main_content_present: 0.8, still_loading: 0.5 }), "wait", "probable content still needs a clear not-loading");
  assert.equal(verdict({ main_content_present: 0.95, still_loading: 0.5 }), "ready", "certain content is not vetoed by a vague loading signal");
  assert.equal(verdict({ main_content_present: 0.95, still_loading: 0.8 }), "wait", "but a clear loading signal still waits");
  assert.deepEqual(verdict({ main_content_present: 0.05, bot_check: 0.95 }), { blocked: "bot_check" });
  assert.deepEqual(verdict({ main_content_present: 0.05, login_or_paywall: 0.9 }), { blocked: "login_wall" });
  assert.equal(verdict({ main_content_present: 0.5, bot_check: 0.95 }), "wait", "a blocker only wins when the content is clearly absent");
  assert.equal(decision({ answers: {} }), undefined);
  assert.equal(decision({ answers: { ...answers().answers, still_loading: { type: "bool", probability: 2 } } }), undefined);
});

test("one combined request carries the screenshot and every question, and nothing scans or hides overlays", async () => {
  const page = makePage();
  const requests = [];
  const jev = { async evaluate(request) { requests.push(request); return answers(READY); } };
  const verdict = await run(page, jev);
  assert.equal(verdict.incomplete, false);
  assert.equal(verdict.pageKind, "content");
  assert.equal(requests.length, 1, "text and visual judgements are one request, not two");
  assert.equal(requests[0].images.length, 1);
  assert.deepEqual(Object.keys(requests[0].questions).sort(), [...QUESTION_IDS].sort());
  assert.equal(page.calls.scans, 0);
  assert.equal(verdict.visualVerdicts, 1);
});

test("a consent dialog over visible content does not delay or block the read", async () => {
  const page = makePage({ current: { ...sample, consentText: "We use cookies. Accept or reject." } });
  let calls = 0;
  const jev = { async evaluate() { calls++; return answers({ ...READY, consent_only: 0.04 }); } };
  const verdict = await run(page, jev);
  assert.equal(verdict.incomplete, false);
  assert.equal(verdict.blocked, undefined);
  assert.equal(calls, 1);
  assert.equal(page.calls.scans, 0);
});

test("a strong verdict is accepted when the DOM heuristics are weak", async () => {
  const page = makePage({ current: weak });
  const jev = { async evaluate() { return answers(READY); } };
  const verdict = await run(page, jev);
  assert.equal(verdict.incomplete, false);
  assert.equal(verdict.pageKind, "content");
  assert.ok(verdict.visualScore >= 0.9);
});

test("a bot check page is reported as blocked", async () => {
  const page = makePage({ current: { ...sample, contentEvidence: false, textLength: 60, text: "Vérification de sécurité en cours" } });
  const jev = { async evaluate() { return answers({ main_content_present: 0.02, bot_check: 0.97 }); } };
  const verdict = await run(page, jev);
  assert.equal(verdict.blocked, "bot_check");
  assert.equal(verdict.incomplete, false);
});

test("a consent wall with no content is only reported once the wait budget is spent", async () => {
  const page = makePage({ current: { ...sample, contentEvidence: false, textLength: 30, text: "", consentText: "Accept cookies" } });
  let calls = 0;
  const jev = { async evaluate() { calls++; return answers({ main_content_present: 0.03, consent_only: 0.96 }); } };
  const verdict = await run(page, jev);
  assert.equal(verdict.blocked, "consent_wall");
  assert.ok(calls > 1, "keeps polling in case the content arrives");
  assert.ok(page.now() >= 7000);
});

test("a screenshot failure falls back to the same questions without an image", async () => {
  const page = makePage({ failScreenshot: true });
  const requests = [];
  const jev = { async evaluate(request) { requests.push(request); return answers(READY); } };
  const verdict = await run(page, jev);
  assert.equal(verdict.incomplete, false);
  assert.equal(requests[0].images, undefined);
  assert.deepEqual(Object.keys(requests[0].questions).sort(), [...QUESTION_IDS].sort());
  assert.equal(verdict.visualVerdicts, 0);
});

test("an unparseable text-only answer falls back to the mechanical rules", async () => {
  const page = makePage({ screenshot: false });
  const jev = { async evaluate() { return { answers: {} }; } };
  const verdict = await run(page, jev);
  assert.equal(verdict.fallback, true);
  assert.equal(verdict.incomplete, false);
});

test("the mechanical fallback is used without Jev", async () => {
  const page = makePage({ screenshot: false });
  const verdict = await run(page, undefined);
  assert.equal(verdict.incomplete, false);
  assert.equal(verdict.fallback, true);
});

test("an uncertain answer keeps waiting until a confident one arrives", async () => {
  const page = makePage({ current: weak });
  let calls = 0;
  const jev = { async evaluate() { calls++; return calls < 3 ? answers({ main_content_present: 0.5, still_loading: 0.6 }) : answers(READY); } };
  const verdict = await run(page, jev);
  assert.equal(verdict.incomplete, false);
  assert.equal(calls, 3);
});

test("a consent overlay that blocks the view is cleared, then the read is re-asked and completes", async () => {
  let cleared = false;
  const events = [];
  const page = makePage({
    current: { ...sample, contentEvidence: false, textLength: 30, text: "", consentText: "" },
    consentTools: {
      async clearConsentOverlay() { cleared = true; events.push("clear"); return { clicked: 0, hidden: 1 }; },
      async restoreConsentOverlay() { events.push("restore"); return 1; },
    },
  });
  let calls = 0;
  const jev = {
    async evaluate() {
      calls++;
      return cleared ? answers(READY) : answers({ main_content_present: 0.2, consent_overlay_blocking: 0.95 });
    },
  };
  const verdict = await run(page, jev);
  assert.equal(verdict.incomplete, false);
  assert.deepEqual(events, ["clear"]);
  assert.equal(calls, 2);
  assert.equal(verdict.overlayCleared, 1);
});

test("content that is already ready never triggers consent clearing, even with a blocking dialog", async () => {
  const events = [];
  const page = makePage({ consentTools: { async clearConsentOverlay() { events.push("clear"); return { clicked: 1, hidden: 1 }; }, async restoreConsentOverlay() { return 0; } } });
  const jev = { async evaluate() { return answers({ ...READY, consent_overlay_blocking: 0.97 }); } };
  const verdict = await run(page, jev);
  assert.equal(verdict.incomplete, false);
  assert.deepEqual(events, []);
  assert.equal(verdict.overlayCleared, undefined);
});

test("clearing that makes the content probability collapse is restored and not retried", async () => {
  let cleared = false;
  const events = [];
  const page = makePage({
    current: weak,
    consentTools: {
      async clearConsentOverlay() { cleared = true; events.push("clear"); return { clicked: 0, hidden: 2 }; },
      async restoreConsentOverlay() { cleared = false; events.push("restore"); return 2; },
    },
  });
  const jev = {
    async evaluate() {
      return cleared ? answers({ main_content_present: 0.05, consent_overlay_blocking: 0.9 }) : answers({ main_content_present: 0.6, consent_overlay_blocking: 0.9 });
    },
  };
  const verdict = await run(page, jev);
  assert.deepEqual(events.slice(0, 2), ["clear", "restore"]);
  assert.equal(events.filter((e) => e === "clear").length, 1, "no second attempt after a harmful clear");
  assert.equal(verdict.overlayCleared, undefined);
});
