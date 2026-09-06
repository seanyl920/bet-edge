// First-ever test coverage for modelRegistry.js — the challenger/promote
// gate. This is a recommendation function only; these tests exist to pin
// down exactly when it says "promotable," since getting that wrong would
// mean either hiding a genuinely better model or recommending a worse one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promotionStatus, MIN_PROMOTION_N } from "../server/modelRegistry.js";

test("promotionStatus refuses to judge a group below MIN_PROMOTION_N matched predictions, however good its scores look", () => {
  const result = promotionStatus({ comparison: { n: MIN_PROMOTION_N - 1, modelBrierScore: 0.01, marketBrierScore: 0.5 } });
  assert.equal(result.promotable, false);
  assert.match(result.reason, /more matched/);
});

test("promotionStatus recommends promotion once n clears the bar AND the model's Brier score beats the market's", () => {
  const result = promotionStatus({ comparison: { n: MIN_PROMOTION_N, modelBrierScore: 0.1, marketBrierScore: 0.2 } });
  assert.equal(result.promotable, true);
});

test("promotionStatus treats an exact tie as promotable (<=, not strictly <)", () => {
  const result = promotionStatus({ comparison: { n: MIN_PROMOTION_N, modelBrierScore: 0.2, marketBrierScore: 0.2 } });
  assert.equal(result.promotable, true);
});

test("promotionStatus refuses promotion when the model is worse than the market, even with plenty of volume", () => {
  const result = promotionStatus({ comparison: { n: MIN_PROMOTION_N * 10, modelBrierScore: 0.3, marketBrierScore: 0.2 } });
  assert.equal(result.promotable, false);
  assert.match(result.reason, /still worse/);
});

test("promotionStatus refuses promotion when a Brier score is missing, never treating null as 'good'", () => {
  const result = promotionStatus({ comparison: { n: MIN_PROMOTION_N, modelBrierScore: null, marketBrierScore: 0.2 } });
  assert.equal(result.promotable, false);
});

test("promotionStatus handles a missing/empty comparison object without throwing", () => {
  assert.doesNotThrow(() => promotionStatus({}));
  assert.equal(promotionStatus({}).promotable, false);
});
