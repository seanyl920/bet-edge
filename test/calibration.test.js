// getCalibration() takes an injectable listBetsFn (defaults to betlog.js's
// real listBets(), which reads data/bets.json) specifically so this can
// exercise the bucketing/dedup logic with a fixture instead of touching
// the real bet log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getCalibration, lookupTrendCalibration, lookupTrendPointCalibration } from "../server/calibration.js";

function trendBet({ id, eventId, playerId = "p1", trendType = "hitStreak", side = "Over", point = 1.5, score = 9, hit }) {
  return {
    id,
    sport: "mlb",
    legs: [{ sport: "mlb", eventId, market: trendType, context: { kind: "trend", playerId, trendType, propSide: side, propPoint: point, score } }],
    postmortem: { legs: [{ hit, note: "stub" }] },
  };
}

function edgeBet({ id, eventId, market = "moneyline", side = "home", line = null, hit }) {
  return {
    id,
    sport: "mlb",
    legs: [{ sport: "mlb", eventId, market, context: { kind: "edge", side, line } }],
    postmortem: { legs: [{ hit, note: "stub" }] },
  };
}

test("getCalibration does NOT let 15 copies of the same real occurrence inflate n to 15", async () => {
  // Reproduces the reviewer's exact scenario: the same player/event/market/
  // side/threshold logged as 15 separate bet-log entries (no dedup on
  // addBet() prevents this from happening in practice).
  const bets = Array.from({ length: 15 }, (_, i) => trendBet({ id: `dup-${i}`, eventId: "evt-1", hit: true }));

  const { buckets } = await getCalibration({ listBetsFn: async () => bets });
  const scoreBucket = buckets.find((b) => b.key.startsWith("trend:mlb:hitStreak:over:"));
  assert.ok(scoreBucket, "expected the score-ranking bucket to exist");
  assert.equal(scoreBucket.n, 1, "15 copies of the same real occurrence must count as ONE observation, not 15");
  assert.equal(scoreBucket.calibrated, false, "n=1 must not clear MIN_SAMPLE=15");

  const pointBucket = buckets.find((b) => b.key.startsWith("trendpoint:mlb:hitStreak:over:"));
  assert.equal(pointBucket.n, 1, "the pricing bucket must be deduped the same way as the ranking bucket");
});

test("getCalibration still counts the SAME bet type on genuinely different games independently", async () => {
  // 15 real, distinct games — this IS 15 independent observations and must
  // still reach calibrated status. Confirms the fix doesn't overcorrect
  // into collapsing legitimate repeats.
  const bets = Array.from({ length: 15 }, (_, i) => trendBet({ id: `game-${i}`, eventId: `evt-${i}`, hit: true }));

  const { buckets } = await getCalibration({ listBetsFn: async () => bets });
  const scoreBucket = buckets.find((b) => b.key.startsWith("trend:mlb:hitStreak:over:"));
  assert.equal(scoreBucket.n, 15);
  assert.equal(scoreBucket.calibrated, true);
});

test("getCalibration never collapses legs missing eventId — unverifiable identity is left uncollapsed, not guessed", async () => {
  const bets = Array.from({ length: 3 }, (_, i) => trendBet({ id: `noevt-${i}`, eventId: null, hit: true }));

  const { buckets } = await getCalibration({ listBetsFn: async () => bets });
  const scoreBucket = buckets.find((b) => b.key.startsWith("trend:mlb:hitStreak:over:"));
  assert.equal(scoreBucket.n, 3, "legs without an eventId can't be verified as duplicates, so they must not be silently collapsed");
});

test("getCalibration dedupes edge-kind legs by (eventId, market, side, line) the same way", async () => {
  const bets = [
    ...Array.from({ length: 10 }, (_, i) => edgeBet({ id: `edgedup-${i}`, eventId: "evt-edge-1", hit: true })),
    edgeBet({ id: "edge-real-2", eventId: "evt-edge-2", hit: true }),
  ];

  const { buckets } = await getCalibration({ listBetsFn: async () => bets });
  const bucket = buckets.find((b) => b.key.startsWith("edge:mlb:moneyline:"));
  assert.equal(bucket.n, 2, "10 copies of evt-edge-1 plus 1 real evt-edge-2 must count as 2 real occurrences");
});

test("getCalibration shrinks a calibrated bucket's rate toward 50% instead of handing out a raw n=15 100% frequency", async () => {
  // Confirmed real bug (external review, Sept 2026): a bucket at exactly
  // MIN_SAMPLE with a perfect record used to hand out its raw 100%
  // frequency as-is — an extraordinary, overconfident claim from a small
  // sample. shrunkRatePct must be materially pulled toward the 50% prior.
  const bets = Array.from({ length: 15 }, (_, i) => trendBet({ id: `perfect-${i}`, eventId: `evt-perf-${i}`, hit: true }));

  const { buckets } = await getCalibration({ listBetsFn: async () => bets });
  const scoreBucket = buckets.find((b) => b.key.startsWith("trend:mlb:hitStreak:over:"));
  assert.equal(scoreBucket.hitRatePct, 100, "raw frequency must still be reported honestly");
  assert.ok(scoreBucket.shrunkRatePct < 100, "the rate actually used for pricing must not be a flat 100% off 15 samples");
  assert.ok(scoreBucket.shrunkRatePct > 50, "still meaningfully above 50% — shrinkage tempers, it doesn't erase, a real 15/15 record");
});

test("getCalibration's shrinkage converges toward the raw rate as sample size grows (the prior stops mattering with real volume)", async () => {
  const few = Array.from({ length: 15 }, (_, i) => trendBet({ id: `few-${i}`, eventId: `evt-few-${i}`, hit: true }));
  const many = Array.from({ length: 150 }, (_, i) => trendBet({ id: `many-${i}`, eventId: `evt-many-${i}`, hit: true }));

  const { buckets: fewBuckets } = await getCalibration({ listBetsFn: async () => few });
  const { buckets: manyBuckets } = await getCalibration({ listBetsFn: async () => many });
  const fewRate = fewBuckets.find((b) => b.key.startsWith("trend:mlb:hitStreak:over:")).shrunkRatePct;
  const manyRate = manyBuckets.find((b) => b.key.startsWith("trend:mlb:hitStreak:over:")).shrunkRatePct;
  assert.ok(manyRate > fewRate, "150/150 should be trusted closer to its raw 100% than 15/15 is");
});

test("lookupTrendCalibration and lookupTrendPointCalibration return the SHRUNK rate, not the raw hitRatePct", async () => {
  const bets = Array.from({ length: 15 }, (_, i) =>
    trendBet({ id: `lookup-${i}`, eventId: `evt-lookup-${i}`, point: 2.5, hit: true })
  );
  const { buckets } = await getCalibration({ listBetsFn: async () => bets });
  const scoreBucket = buckets.find((b) => b.key.startsWith("trend:mlb:hitStreak:over:"));
  const pointBucket = buckets.find((b) => b.key.startsWith("trendpoint:mlb:hitStreak:over:2.5"));

  const scoreLookup = lookupTrendCalibration(buckets, "mlb", "hitStreak", "Over", 9);
  const pointLookup = lookupTrendPointCalibration(buckets, "mlb", "hitStreak", "Over", 2.5);
  assert.equal(scoreLookup.rate, scoreBucket.shrunkRatePct / 100);
  assert.equal(pointLookup.rate, pointBucket.shrunkRatePct / 100);
  assert.notEqual(scoreLookup.rate, scoreBucket.hitRatePct / 100, "must not silently fall back to the raw, unshrunk rate");
});

test("getCalibration treats two different players in the same game as different occurrences", async () => {
  const bets = [
    trendBet({ id: "player-a", eventId: "evt-1", playerId: "playerA", hit: true }),
    trendBet({ id: "player-b", eventId: "evt-1", playerId: "playerB", hit: true }),
  ];

  const { buckets } = await getCalibration({ listBetsFn: async () => bets });
  const scoreBucket = buckets.find((b) => b.key.startsWith("trend:mlb:hitStreak:over:"));
  assert.equal(scoreBucket.n, 2, "different players in the same game are genuinely different occurrences");
});
