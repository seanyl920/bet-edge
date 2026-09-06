// First-ever test coverage for elo.js. Added alongside the pushProbability
// fix (external review, Sept 2026, claim: "spread EV ignores pushes") —
// coverProbability's own math is unchanged by this round, but nothing
// previously pinned it down, and pushProbability is new.
import { test } from "node:test";
import assert from "node:assert/strict";
import { coverProbability, pushProbability } from "../server/elo.js";

test("pushProbability is exactly 0 for a half-point spread — a push is genuinely impossible there", () => {
  const p = pushProbability({ expectedMarginHome: 3, marketSpreadHome: -3.5, marginSigma: 13.5 });
  assert.equal(p, 0);
});

test("pushProbability is positive for an integer spread when the expected margin sits near the line", () => {
  // -3 is the single most common NFL final-margin gap — a real, non-trivial
  // push chance, not a rounding artifact.
  const p = pushProbability({ expectedMarginHome: 3, marketSpreadHome: -3, marginSigma: 13.5 });
  assert.ok(p > 0 && p < 1);
});

test("pushProbability is positive at a pick'em (0) line too — a tied final score can push there", () => {
  const p = pushProbability({ expectedMarginHome: 0.5, marketSpreadHome: 0, marginSigma: 13.5 });
  assert.ok(p > 0);
});

test("pushProbability shrinks as the expected margin moves further from the line (less mass right at the threshold)", () => {
  const near = pushProbability({ expectedMarginHome: 3, marketSpreadHome: -3, marginSigma: 13.5 });
  const far = pushProbability({ expectedMarginHome: 20, marketSpreadHome: -3, marginSigma: 13.5 });
  assert.ok(far < near);
});

test("coverProbability is unaffected by the pushProbability addition (regression, hand-computed z=0 case)", () => {
  // expectedMarginHome exactly at the (negated) line -> z=0 -> normalCdf(0) = 0.5
  const p = coverProbability({ expectedMarginHome: 3, marketSpreadHome: -3, marginSigma: 13.5 });
  assert.ok(Math.abs(p - 0.5) < 1e-6);
});

test("cover + push never exceeds 1 (they describe non-overlapping outcomes of the same distribution)", () => {
  const params = { expectedMarginHome: 4, marketSpreadHome: -3, marginSigma: 13.5 };
  const cover = coverProbability(params);
  const push = pushProbability(params);
  assert.ok(cover + push <= 1 + 1e-9);
});
