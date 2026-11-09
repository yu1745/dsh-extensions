import test from "node:test";
import assert from "node:assert/strict";

const { readinessInput, visualReadinessInput, waitForReadableContent } = await import(
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

test("readinessInput carries list and video evidence as observations", () => {
  const input = readinessInput("https://example.com", {
    ...sample,
    contentEvidence: false,
    listEvidence: true,
    mediaEvidence: true,
  });
  assert.equal(input.questions.page_kind.type, "choice");
  assert.equal(input.questions.is_ready.type, "bool");
  assert.ok(input.state.observations.some((line) => line.includes("link-dense list")));
  assert.ok(input.state.observations.some((line) => line.includes("video player")));
});

test("visualReadinessInput asks a screenshot-backed readiness question", () => {
  const input = visualReadinessInput("https://example.com", sample);
  assert.equal(input.questions.is_ready.type, "bool");
  assert.match(input.questions.is_ready.instructions, /screenshot/i);
  assert.ok(input.state.observations.some((line) => line.includes("screenshot")));
});

test("waitForReadableContent accepts a strong visual verdict when mechanical signals are weak", async () => {
  let clock = 0;
  let imageCalls = 0;
  const page = {
    async evaluate(expression) {
      if (String(expression).includes("contentEvidence")) {
        return { ...sample, textLength: 40, contentEvidence: false, pendingContent: true, text: "Loading" };
      }
      return false; // consent dismissal
    },
    async waitForTimeout(ms) {
      clock += ms;
    },
    async screenshot() {
      return new Uint8Array(2000);
    },
  };
  const jev = {
    async evaluate(request) {
      const visual = Array.isArray(request.images) && request.images.length > 0;
      if (visual) imageCalls++;
      return {
        answers: {
          page_kind: {
            type: "choice",
            choice: "content",
            probabilities: { content: 1, content_gate: 0, login_wall: 0, bot_check: 0, consent_wall: 0, error_page: 0 },
            confidence: 1,
          },
          is_ready: { type: "bool", probability: visual ? 0.99 : 0.1 },
        },
      };
    },
  };
  const verdict = await waitForReadableContent(page, "https://example.com", jev, undefined, () => clock);
  assert.equal(verdict.incomplete, false);
  assert.equal(verdict.pageKind, "content");
  assert.equal(verdict.visualVerdicts, 1);
  assert.ok(imageCalls >= 1);
});

test("waitForReadableContent keeps the mechanical fallback without Jev", async () => {
  let clock = 0;
  const page = {
    async evaluate(expression) {
      if (String(expression).includes("contentEvidence")) return sample;
      return false;
    },
    async waitForTimeout(ms) {
      clock += ms;
    },
  };
  const verdict = await waitForReadableContent(page, "https://example.com", undefined, undefined, () => clock);
  assert.equal(verdict.incomplete, false);
  assert.equal(verdict.fallback, true);
});
