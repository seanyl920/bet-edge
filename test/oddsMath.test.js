// First-ever test coverage for oddsMath.js. Added alongside the pushProb
// fix (external review, Sept 2026, claim: "spread EV ignores pushes") —
// expectedValue/kellyStake previously had a single, silent assumption
// (every non-win is a full loss) with nothing pinning down that either the
// old behavior (pushProb omitted) or the new behavior (pushProb > 0)
// actually does what it claims.
import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedValue, kellyStake, normalCdf, normalPdf } from "../server/oddsMath.js";

test("expectedValue with no pushProb matches the original binary win/lose formula exactly (regression)", () => {
  // -110 American = 1.909... decimal. A break-even 52.38% true prob should
  // be ~0 EV; hand-computed away from that to something unambiguous.
  const decimalOdds = 1.9091;
  const ev = expectedValue(0.6, decimalOdds);
  const expected = 0.6 * (decimalOdds - 1) - 0.4;
  assert.ok(Math.abs(ev - expected) < 1e-9);
});

test("expectedValue: a real pushProb raises EV relative to treating the push as a loss", () => {
  // Same win probability and price, only difference is whether 10% of the
  // "doesn't win" mass is a push (refund) or a loss.
  const decimalOdds = 1.91;
  const evIgnoringPush = expectedValue(0.5, decimalOdds, 0);
  const evWithPush = expectedValue(0.5, decimalOdds, 0.1);
  assert.ok(evWithPush > evIgnoringPush, "carving out a push as a non-loss must never make EV look worse");
  // Exact formula check: loseProb = 1 - trueProb - pushProb.
  const expected = 0.5 * (decimalOdds - 1) - 0.4;
  assert.ok(Math.abs(evWithPush - expected) < 1e-9);
});

test("expectedValue clamps loseProb at 0 if trueProb+pushProb somehow exceeds 1 (shouldn't happen, but must not go negative-loss)", () => {
  const ev = expectedValue(0.9, 2, 0.2); // 0.9+0.2 = 1.1
  const expected = 0.9 * (2 - 1) - 0; // loseProb clamped to 0, not -0.1
  assert.equal(ev, expected);
});

test("kellyStake with no pushProb matches the original formula exactly (regression)", () => {
  const decimalOdds = 2.0;
  const stake = kellyStake(0.6, decimalOdds, 1); // full Kelly for an exact hand-check
  const b = decimalOdds - 1;
  const expected = (0.6 * b - 0.4) / b;
  assert.ok(Math.abs(stake - expected) < 1e-9);
});

test("kellyStake returns 0 for a -EV bet, pushProb or not", () => {
  assert.equal(kellyStake(0.3, 1.5), 0);
  assert.equal(kellyStake(0.3, 1.5, 0.25, 0.1), 0);
});

test("kellyStake: a real pushProb changes the recommended stake relative to ignoring it (not just a copy of expectedValue's adjustment)", () => {
  const decimalOdds = 2.2;
  const noPush = kellyStake(0.5, decimalOdds, 1, 0);
  const withPush = kellyStake(0.5, decimalOdds, 1, 0.15);
  assert.notEqual(noPush, withPush);
});

test("normalPdf is the standard normal density: symmetric, peak at 0, matches the constant reused inside normalCdf", () => {
  assert.ok(Math.abs(normalPdf(0) - 0.3989423) < 1e-6);
  assert.ok(Math.abs(normalPdf(1) - normalPdf(-1)) < 1e-9, "standard normal density must be symmetric");
  assert.ok(normalPdf(0) > normalPdf(1), "density must peak at 0");
});

test("normalCdf(0) is 0.5 (regression — must be unaffected by factoring normalPdf out of it)", () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
});
