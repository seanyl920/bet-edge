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

// Confirmed real bug (external review, Sept 2026): modelBrierScoreAllRows
// and marketBrierScoreAllRows below each filter to their OWN field being
// non-null, independently — so they can (and in a reproduced fixture, did)
// score two DIFFERENT subsets of predictions and disagree with what the
// numbers looked like on the predictions they actually share. A reviewer's
// fixture reported model 0.036 vs market 0.25 (model looks much better) on
// the independent scores, while the SAME data scored model 0.36 on just the
// rows both scores could actually be computed on — the market was better
// there, the opposite conclusion. Comparing "beats the market" requires
// scoring both sides on the exact same predictions — see `comparison` below,
// which is the field an evaluation should actually read to answer that
// question. The two *AllRows fields are kept as separate diagnostics (how
// well-calibrated is this app's own probability, full stop; same for the
// market's) — deliberately NOT presented as comparable to each other.
function matchedBrierComparison(rows) {
  const matched = rows.filter((r) => r.predictedProb != null && r.marketProb != null);
  if (!matched.length) return { n: 0, modelBrierScore: null, marketBrierScore: null };
  const scoreFor = (field) => matched.reduce((s, r) => s + (r[field] - (r.hit ? 1 : 0)) ** 2, 0) / matched.length;
  return { n: matched.length, modelBrierScore: round(scoreFor("predictedProb")), marketBrierScore: round(scoreFor("marketProb")) };
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
    // Each scored over its OWN available rows — NOT necessarily the same
    // predictions, so these two are not directly comparable to each other
    // (see matchedBrierComparison's comment above for why that matters and
    // what went wrong when this app first tried to compare them directly).
    // Read these as "how calibrated is the model, on its own" / "how
    // calibrated is the market, on its own."
    modelBrierScoreAllRows: round(brierScore(rows, "predictedProb")),
    marketBrierScoreAllRows: round(brierScore(rows, "marketProb")),
    // THE fair comparison: both scores computed on exactly the same set of
    // predictions (only rows with both a model AND a market probability).
    // This — not the two fields above — is what should decide "beats the
    // market" or "doesn't." `n` here can be smaller than the group's total
    // `n` above; a comparison built on very few matched rows isn't worth
    // much either, so check `comparison.n` before trusting it.
    comparison: matchedBrierComparison(rows),
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
  const ungradedReasons = { notFinalOrMissing: 0, gradingThrew: 0, noLeg: 0, postStart: 0 };

  for (const record of records) {
    if (!record.leg) {
      ungradedReasons.noLeg++;
      continue;
    }

    // Defense in depth for the same "no post-start snapshots" rule
    // predictionLog.js enforces when a record is written (see its
    // recordPrediction) — catches a record that predates that fix, or
    // reached the file some other way, rather than trusting every stored
    // record was necessarily pregame.
    const commenceMs = record.leg.commenceTime ? new Date(record.leg.commenceTime).getTime() : NaN;
    const recordedMs = record.recordedAt ? new Date(record.recordedAt).getTime() : NaN;
    if (!Number.isNaN(commenceMs) && !Number.isNaN(recordedMs) && recordedMs >= commenceMs) {
      ungradedReasons.postStart++;
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
