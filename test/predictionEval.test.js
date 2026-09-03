// Same throwaway-file pattern as predictionLog.test.js. analyzeBet itself
// hits ESPN over the network (unavailable in this sandbox — see README), so
// evaluatePredictions() takes an injectable analyzeBetFn specifically so
// this can be tested without live network access; the stub below returns
// canned grading results keyed off the leg's own captured fields.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "predeval-test-"));
process.env.PREDICTION_LOG_FILE = path.join(dir, "predictionLog.jsonl");

const { recordPrediction } = await import("../server/predictionLog.js");
const { evaluatePredictions } = await import("../server/predictionEval.js");

// recordPrediction() now rejects a commenceTime already in the past at
// write time (see predictionLog.js) — these fixtures need a future
// timestamp so the write itself succeeds; the stub analyzeBetFn grades by
// eventId parity alone and doesn't care whether the "game" has actually
// happened yet, so this doesn't undermine what these tests are checking.
function futureCommenceTime(msFromNow = 60 * 60 * 1000) {
  return new Date(Date.now() + msFromNow).toISOString();
}

function record(overrides = {}) {
  return {
    sport: "mlb",
    kind: "trend",
    subjectId: overrides.subjectId ?? "p1",
    subjectName: "Test Player",
    market: "hitStreak",
    side: "Over",
    point: 1.5,
    predictedProb: 0.6,
    marketProb: 0.55,
    probSource: "devig",
    leg: {
      label: "leg",
      eventId: overrides.eventId ?? "evt-1",
      commenceTime: futureCommenceTime(),
      matchup: "AAA @ BBB",
      market: "hitStreak",
      selection: "Over 1.5",
      americanOdds: -120,
      sport: "mlb",
      context: { kind: "trend" },
    },
    ...overrides,
  };
}

// A stub standing in for postmortem.js's analyzeBet(): "wins" if the leg's
// eventId ends in an odd digit, "not final yet" (hit: null) if it ends in
// 9, so both the graded and ungraded paths get exercised.
async function stubAnalyzeBet(bet) {
  const leg = bet.legs[0];
  const lastChar = leg.eventId.slice(-1);
  if (lastChar === "9") return { legs: [{ hit: null, note: "Game not final yet." }] };
  const hit = Number(lastChar) % 2 === 1;
  return { legs: [{ hit, note: "stub" }] };
}

test("evaluatePredictions grades records via analyzeBetFn and excludes ungraded ones from stats", async () => {
  await recordPrediction(record({ subjectId: "eval-a", eventId: "evt-a1" })); // odd -> hit
  await recordPrediction(record({ subjectId: "eval-b", eventId: "evt-a2" })); // even -> miss
  await recordPrediction(record({ subjectId: "eval-c", eventId: "evt-a9" })); // not final

  const result = await evaluatePredictions({ analyzeBetFn: stubAnalyzeBet });
  assert.ok(result.totalLogged >= 3);
  assert.ok(result.ungradedReasons.notFinalOrMissing >= 1);

  const group = result.groups.find((g) => g.market === "hitStreak" && g.kind === "trend" && g.sport === "mlb");
  assert.ok(group, "expected a hitStreak/trend/mlb group in the aggregate");
  assert.ok(group.n >= 2);
  assert.ok(group.wins >= 1);
  assert.equal(typeof group.hitRate, "number");
  assert.ok(group.hitRate >= 0 && group.hitRate <= 1);
});

test("evaluatePredictions computes a Brier score comparing predictedProb (and marketProb) to realized outcomes", async () => {
  // Own market name so this group can't accumulate rows from other tests
  // sharing the same predictionLog.jsonl file (they're isolated by
  // subjectId for dedup purposes, but not by market/group).
  const market = "hitStreakBrierBasic";
  await recordPrediction(record({ subjectId: "brier-a", eventId: "evt-b1", market, predictedProb: 0.9, marketProb: 0.5 })); // odd -> hit=true; (0.9-1)^2=0.01, (0.5-1)^2=0.25
  await recordPrediction(record({ subjectId: "brier-b", eventId: "evt-b2", market, predictedProb: 0.9, marketProb: 0.5 })); // even -> hit=false; (0.9-0)^2=0.81, (0.5-0)^2=0.25

  const result = await evaluatePredictions({ analyzeBetFn: stubAnalyzeBet });
  const group = result.groups.find((g) => g.market === market);
  // model: mean(0.01, 0.81) = 0.41; market: mean(0.25, 0.25) = 0.25 — model
  // is worse-calibrated here on purpose, so this also checks the two scores
  // are computed independently (not accidentally identical).
  assert.ok(group.modelBrierScoreAllRows > group.marketBrierScoreAllRows);
  // Both rows have both fields present, so the fair matched comparison
  // should agree with the all-rows scores exactly in this case.
  assert.equal(group.comparison.n, 2);
  assert.equal(group.comparison.modelBrierScore, group.modelBrierScoreAllRows);
  assert.equal(group.comparison.marketBrierScore, group.marketBrierScoreAllRows);
});

test("evaluatePredictions' matched comparison can disagree with the independent all-rows scores — this is the bug the comparison field exists to prevent", async () => {
  // Reproduces the exact failure mode: many predictions have only
  // predictedProb (no marketProb) and are all correct high-confidence
  // calls (near-zero model error) — those alone would make the model look
  // far better than the market. But the handful of predictions that
  // actually have BOTH fields tell the opposite story: the model is worse
  // than the market on the predictions that can actually be compared.
  const market = "hitStreakBrierMismatch"; // own market name — see the isolation comment in the test above
  for (let i = 0; i < 10; i++) {
    // eventId ends in 1 -> odd -> hit=true (via stubAnalyzeBet)
    await recordPrediction(
      record({ subjectId: `matched-modelonly-${i}`, eventId: `evt-modelonly-${i}1`, market, predictedProb: 0.95, marketProb: null })
    );
  }
  // Two rows with BOTH fields, where the model is clearly WORSE than the
  // market: confidently wrong both times, while the market leaned the
  // right way both times.
  await recordPrediction(
    record({ subjectId: "matched-both-a", eventId: "evt-both-a1", market, predictedProb: 0.1, marketProb: 0.6 })
    // eventId ends in "1" -> odd -> hit=true: model (0.1-1)^2=0.81, market (0.6-1)^2=0.16
  );
  await recordPrediction(
    record({ subjectId: "matched-both-b", eventId: "evt-both-b2", market, predictedProb: 0.9, marketProb: 0.4 })
    // eventId ends in "2" -> even -> hit=false: model (0.9-0)^2=0.81, market (0.4-0)^2=0.16
  );

  const result = await evaluatePredictions({ analyzeBetFn: stubAnalyzeBet });
  const group = result.groups.find((g) => g.market === market);

  // The all-rows model score is pulled way down by the 10 confident,
  // correct, market-less predictions (error ~0.0025 each) diluting the 2
  // genuinely bad ones (error 0.81 each) — 12 rows average to ~0.137,
  // beating the all-rows market score of 0.16 (computed from just the 2
  // bad-for-the-model rows, since only those 2 have a marketProb at all).
  assert.ok(
    group.modelBrierScoreAllRows < group.marketBrierScoreAllRows,
    `expected the independent (non-comparable) scores to mislead in the model's favor here — got model ${group.modelBrierScoreAllRows} vs market ${group.marketBrierScoreAllRows}`
  );

  // The FAIR comparison — same rows for both — tells the true, opposite
  // story: on the only predictions where both a model and a market
  // probability exist, the model is clearly worse.
  assert.equal(group.comparison.n, 2);
  assert.equal(group.comparison.modelBrierScore, 0.81);
  assert.equal(group.comparison.marketBrierScore, 0.16);
  assert.ok(group.comparison.modelBrierScore > group.comparison.marketBrierScore);
});

test("evaluatePredictions excludes a record whose recordedAt is at or after its own commenceTime — defense in depth", async () => {
  // recordPrediction() itself now refuses to write a post-start snapshot
  // (see predictionLog.js), so simulate a record that reached the file
  // some other way (predates that fix, a bug, direct file access) by
  // appending a raw line, bypassing recordPrediction entirely.
  const { appendFile } = await import("node:fs/promises");
  const badRecord = {
    id: "post-start-1",
    recordedAt: "2026-09-01T22:00:00Z", // AFTER commenceTime below — recorded once the game was already underway
    modelVersion: "test",
    sport: "mlb",
    kind: "trend",
    subjectId: "poststart-eval-1",
    market: "hitStreakPostStart",
    side: "Over",
    point: 1.5,
    predictedProb: 0.6,
    marketProb: 0.55,
    leg: {
      label: "leg",
      eventId: "evt-poststart-1",
      commenceTime: "2026-09-01T21:00:00Z", // 1 hour before recordedAt above
      matchup: "AAA @ BBB",
      market: "hitStreakPostStart",
      selection: "Over 1.5",
      americanOdds: -120,
      sport: "mlb",
      context: { kind: "trend" },
    },
  };
  await appendFile(process.env.PREDICTION_LOG_FILE, JSON.stringify(badRecord) + "\n");

  const result = await evaluatePredictions({ analyzeBetFn: stubAnalyzeBet });
  assert.equal(result.ungradedReasons.postStart, 1);
  const group = result.groups.find((g) => g.market === "hitStreakPostStart");
  assert.equal(group, undefined, "a post-start record must never contribute to any group's stats");
});

test("evaluatePredictions never throws when analyzeBetFn itself throws", async () => {
  await recordPrediction(record({ subjectId: "throws-a", eventId: "evt-c1" }));
  await assert.doesNotReject(() =>
    evaluatePredictions({
      analyzeBetFn: async () => {
        throw new Error("simulated ESPN failure");
      },
    })
  );
});

test.after(async () => {
  await rm(dir, { recursive: true, force: true });
});
