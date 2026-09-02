// Prospective-evaluation aggregator. Reads everything predictionLog.js has
// recorded, grades whatever is decidable by now by reusing postmortem.js's
// existing analyzeBet() (never a second, parallel grading path — see
// predictionLog.js's leg-shape comment), and rolls the graded set up into
// hit-rate / calibration stats — grouped so a real modelVersion or market
// change is comparable against what came before it, and so this app's own
// predictedProb is checked against BOTH the realized outcome and the
// marketProb captured at the same moment (the "contemporaneous devigged
// market odds" comparison this project is required to make before claiming
// any improvement).
//
// This is deliberately NOT a historical backtest: this app has no archive
// of past ESPN/odds snapshots to replay, so there is nothing to backtest
// against. What it can do — and does — is grade every prediction it makes
// going forward, honestly, once real outcomes exist. Until there's enough
// graded volume, `n` for a group will just be small; this module never
// pads that with anything else.

import { readPredictionLog } from "./predictionLog.js";
import { analyzeBet } from "./postmortem.js";
import { round } from "./oddsMath.js";

function avg(values) {
  const nums = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (!nums.length) return null;
  return nums.reduce((s, v) => s + v, 0) / nums.length;
}

/** Mean squared error between a stated probability and the realized 0/1 outcome — lower is better calibrated. */
function brierScore(rows, probField) {
  const scored = rows.filter((r) => r[probField] != null);
  if (!scored.length) return null;
  const total = scored.reduce((s, r) => s + (r[probField] - (r.hit ? 1 : 0)) ** 2, 0);
  return total / scored.length;
}

function groupKey(r) {
  return [r.modelVersion, r.sport, r.kind, r.market].join("|");
}

function summarizeGroup(rows) {
  const [{ modelVersion, sport, kind, market }] = rows;
  return {
    modelVersion,
    sport,
    kind,
    market,
    n: rows.length,
    wins: rows.filter((r) => r.hit).length,
    hitRate: round(avg(rows.map((r) => (r.hit ? 1 : 0)))),
    avgPredictedProb: round(avg(rows.map((r) => r.predictedProb))),
    avgMarketProb: round(avg(rows.map((r) => r.marketProb))),
    // Brier score of THIS app's stated probability vs. what actually
    // happened, and the same score for the market's own devigged
    // probability at prediction time — the two are directly comparable
    // (both scored against the same realized outcomes), which is what lets
    // this eventually say "beats the market" or "doesn't" instead of
    // asserting it.
    modelBrierScore: round(brierScore(rows, "predictedProb")),
    marketBrierScore: round(brierScore(rows, "marketProb")),
  };
}

/**
 * Grade every logged prediction whose game is decidable by now, and
 * aggregate the results. A record that can't be graded yet (game not
 * final, missing snapshot, an ESPN hiccup) is excluded entirely — never
 * counted as a loss or backfilled with a guess.
 *
 * `analyzeBetFn` defaults to postmortem.js's real analyzeBet (which hits
 * ESPN) — overridable so tests can exercise the grouping/scoring logic here
 * with a stub instead of live network access.
 */
export async function evaluatePredictions({ analyzeBetFn = analyzeBet } = {}) {
  const records = await readPredictionLog();
  const graded = [];
  const ungradedReasons = { notFinalOrMissing: 0, gradingThrew: 0, noLeg: 0 };

  for (const record of records) {
    if (!record.leg) {
      ungradedReasons.noLeg++;
      continue;
    }
    let result;
    try {
      result = await analyzeBetFn({ sport: record.sport, legs: [record.leg] });
    } catch {
      ungradedReasons.gradingThrew++;
      continue;
    }
    const legResult = result.legs?.[0];
    if (!legResult || legResult.hit == null) {
      ungradedReasons.notFinalOrMissing++;
      continue;
    }
    graded.push({ ...record, hit: legResult.hit, gradeNote: legResult.note });
  }

  const byGroup = new Map();
  for (const row of graded) {
    const key = groupKey(row);
    const arr = byGroup.get(key) ?? [];
    arr.push(row);
    byGroup.set(key, arr);
  }

  return {
    generatedAt: new Date().toISOString(),
    totalLogged: records.length,
    totalGraded: graded.length,
    ungradedReasons,
    groups: [...byGroup.values()].map(summarizeGroup).sort((a, b) => b.n - a.n),
  };
}
