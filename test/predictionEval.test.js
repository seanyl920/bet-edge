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
      commenceTime: "2026-09-01T23:00:00Z",
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
  await recordPrediction(record({ subjectId: "brier-a", eventId: "evt-b1", predictedProb: 0.9, marketProb: 0.5 })); // odd -> hit=true; (0.9-1)^2=0.01, (0.5-1)^2=0.25
  await recordPrediction(record({ subjectId: "brier-b", eventId: "evt-b2", predictedProb: 0.9, marketProb: 0.5 })); // even -> hit=false; (0.9-0)^2=0.81, (0.5-0)^2=0.25

  const result = await evaluatePredictions({ analyzeBetFn: stubAnalyzeBet });
  const group = result.groups.find((g) => g.market === "hitStreak");
  // model: mean(0.01, 0.81) = 0.41; market: mean(0.25, 0.25) = 0.25 — model
  // is worse-calibrated here on purpose, so this also checks the two scores
  // are computed independently (not accidentally identical).
  assert.ok(group.modelBrierScore > group.marketBrierScore);
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
