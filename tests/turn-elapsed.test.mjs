import test from "node:test";
import assert from "node:assert/strict";

const { formatTurnElapsed, workedForLabel } = await import(
  "../lib/turn-elapsed-format.js"
);

test("matches codex FinalMessageSeparator thresholds", () => {
  assert.equal(formatTurnElapsed(0), "<1s");
  assert.equal(formatTurnElapsed(1), "<1s");
  assert.equal(formatTurnElapsed(999), "<1s");
  assert.equal(formatTurnElapsed(1000), "1s");
  assert.equal(formatTurnElapsed(59_999), "59s");
  assert.equal(formatTurnElapsed(60_000), "1m 0s");
  assert.equal(formatTurnElapsed(80_400), "1m 20s");
  assert.equal(formatTurnElapsed(3_599_000), "59m 59s");
  assert.equal(formatTurnElapsed(3_600_000), "1h 0m 0s");
  assert.equal(formatTurnElapsed(7_445_000), "2h 4m 5s");
});

test("floors partial seconds and tolerates junk input", () => {
  assert.equal(formatTurnElapsed(12_999), "12s");
  assert.equal(formatTurnElapsed(-5), "<1s");
  assert.equal(formatTurnElapsed(Number.NaN), "<1s");
  assert.equal(formatTurnElapsed(Number.POSITIVE_INFINITY), "<1s");
});

test("labels use the codex wording", () => {
  assert.equal(workedForLabel(12_000), "Worked for 12s");
  assert.equal(workedForLabel(200), "Worked for <1s");
});
