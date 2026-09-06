// First-ever test coverage for propModel.js (new this round — see README's
// Known-issue history / "what I would build next" entry). Poisson math is
// hand-checkable for small lambda/k, so these assert exact or near-exact
// values, not just "ran without throwing."
import { test } from "node:test";
import assert from "node:assert/strict";
import { poissonPmf, poissonCdf, expectedStrikeouts, poissonPropProbabilities } from "../server/propModel.js";

test("poissonPmf(0, 0) is 1 — zero events is certain when the rate is zero", () => {
  assert.equal(poissonPmf(0, 0), 1);
});

test("poissonPmf(k>0, 0) is 0 — can't observe an event when the rate is zero", () => {
  assert.equal(poissonPmf(3, 0), 0);
});

test("poissonPmf(0, lambda) equals e^-lambda (the textbook closed form)", () => {
  const lambda = 4;
  assert.ok(Math.abs(poissonPmf(0, lambda) - Math.exp(-lambda)) < 1e-9);
});

test("poissonCdf is non-decreasing and converges to 1 as k grows", () => {
  const lambda = 6.2;
  let prev = 0;
  for (let k = 0; k <= 30; k++) {
    const cdf = poissonCdf(k, lambda);
    assert.ok(cdf >= prev - 1e-12, `cdf must never decrease (k=${k})`);
    prev = cdf;
  }
  assert.ok(Math.abs(prev - 1) < 1e-9, "cdf must converge to 1 for k large enough");
});

test("poissonPmf sums to (approximately) the cdf at the same k", () => {
  const lambda = 5;
  let sum = 0;
  for (let k = 0; k <= 10; k++) sum += poissonPmf(k, lambda);
  assert.ok(Math.abs(sum - poissonCdf(10, lambda)) < 1e-9);
});

test("expectedStrikeouts returns null with fewer than 3 real starts — never guesses from a thin sample", () => {
  assert.equal(expectedStrikeouts([{ SO: 7, IP: 6 }]), null);
  assert.equal(expectedStrikeouts([{ SO: 7, IP: 6 }, { SO: 5, IP: 5 }]), null);
  assert.equal(expectedStrikeouts([]), null);
  assert.equal(expectedStrikeouts(null), null);
});

test("expectedStrikeouts computes lambda as (total SO / total IP) * avg IP over real starts — hand-checked", () => {
  // 3 starts: (SO, IP) = (7,6), (5,5), (6,6) -> totalSO=18, totalIP=17
  // kPerIP = 18/17, avgIP = 17/3, lambda = avgIP * kPerIP = totalSO/starts = 18/3 = 6 exactly
  const log = [
    { SO: 7, IP: 6 },
    { SO: 5, IP: 5 },
    { SO: 6, IP: 6 },
  ];
  const result = expectedStrikeouts(log);
  assert.ok(result);
  assert.equal(result.starts, 3);
  assert.ok(Math.abs(result.lambda - 6) < 1e-6);
  // Compared loosely (not 1e-6) because the module rounds to 4 decimal
  // places for display — 18/17 = 1.05882352941..., which rounds to
  // 1.0588, a ~2.4e-5 gap from the unrounded value.
  assert.ok(Math.abs(result.kPerIP - 18 / 17) < 1e-4);
});

test("expectedStrikeouts ignores a bad row (missing IP/SO) rather than letting it corrupt the average", () => {
  const log = [
    { SO: 7, IP: 6 },
    { SO: null, IP: null }, // e.g. a start ESPN hasn't posted innings for yet
    { SO: 5, IP: 5 },
    { SO: 6, IP: 6 },
  ];
  const result = expectedStrikeouts(log);
  assert.equal(result.starts, 3, "the bad row must be filtered out, not counted as a 0/0 start");
});

test("expectedStrikeouts only looks at the most recent MAX_LOOKBACK (8) starts — old form shouldn't dominate", () => {
  const recent = Array.from({ length: 8 }, () => ({ SO: 10, IP: 6 })); // very hot recent form
  const stale = Array.from({ length: 20 }, () => ({ SO: 2, IP: 6 })); // old, cold form beyond the lookback
  const result = expectedStrikeouts([...recent, ...stale]);
  assert.equal(result.starts, 8);
  assert.ok(result.lambda > 9, "the stale 20 cold starts must not drag the average down");
});

test("poissonPropProbabilities on a half-integer line: over+under sum to 1, no push", () => {
  const { over, under, pushProb } = poissonPropProbabilities(6, 6.5);
  assert.equal(pushProb, 0, "a .5 line can never push");
  assert.ok(Math.abs(over + under - 1) < 1e-9);
});

test("poissonPropProbabilities on a half-integer line matches the direct CDF definition (Over 6.5 = P(SO>=7))", () => {
  const lambda = 6;
  const { over } = poissonPropProbabilities(lambda, 6.5);
  const expected = 1 - poissonCdf(6, lambda); // P(SO <= 6) is the complement of Over 6.5
  // `over` is rounded to 4 decimal places by the module; compare loosely.
  assert.ok(Math.abs(over - expected) < 1e-4);
});

test("poissonPropProbabilities on an integer line: over+under+push sum to 1 (a real push, not silently dropped)", () => {
  const { over, under, pushProb } = poissonPropProbabilities(6, 6);
  assert.ok(pushProb > 0, "an integer line has a real, nonzero exact-tie probability");
  assert.ok(Math.abs(over + under + pushProb - 1) < 1e-9);
});

test("poissonPropProbabilities returns null when lambda or line is missing — never fabricates a probability", () => {
  assert.equal(poissonPropProbabilities(null, 6.5), null);
  assert.equal(poissonPropProbabilities(6, null), null);
});

test("higher lambda raises the probability of clearing the same Over line (monotonic in the model's own input)", () => {
  const low = poissonPropProbabilities(4, 6.5).over;
  const high = poissonPropProbabilities(9, 6.5).over;
  assert.ok(high > low);
});
