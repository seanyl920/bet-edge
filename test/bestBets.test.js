// First-ever test coverage for bestBets.js — "today's best bets," the
// direct answer to the review's math complaint about dailyParlay.js's
// favorites-stacking (10 legs @ ~60% each compounds to well under 1%
// combined — not a confident day, a lottery ticket). This never combines
// anything; these tests exist specifically to prove that.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getTodaysBestBets } from "../server/bestBets.js";
import { americanToDecimal } from "../server/oddsMath.js";

function edgeLeg({ label, americanOdds, trueProb, ev, evPct, eventId = "evt-1" }) {
  return {
    source: "edge",
    sport: "nfl",
    label,
    eventId,
    matchup: "AAA @ BBB",
    market: "moneyline",
    selection: label,
    americanOdds,
    decimalOdds: americanToDecimal(americanOdds),
    book: "DraftKings",
    trueProb,
    probSource: "elo-blended",
    // Pre-computed, the way edges.js's makeEdge() really provides it — see
    // withComputedEv's comment for why this must be used as-is, not
    // recomputed, for edge legs.
    ev,
    evPct,
    context: { kind: "edge" },
  };
}

function trendLeg({ label, americanOdds, trueProb, eventId = "evt-2" }) {
  return {
    source: "trend",
    sport: "mlb",
    label,
    eventId,
    matchup: "CCC @ DDD",
    market: "hitStreak",
    selection: label,
    americanOdds,
    decimalOdds: americanToDecimal(americanOdds),
    book: "FanDuel",
    trueProb,
    probSource: "devig",
    context: { kind: "trend" },
  };
}

test("getTodaysBestBets ranks by EV descending, not by raw probability", async () => {
  const edges = async () => [
    edgeLeg({ label: "A", americanOdds: -110, trueProb: 0.55, ev: 0.05, evPct: 5 }), // lower prob, higher EV
    edgeLeg({ label: "B", americanOdds: -400, trueProb: 0.82, ev: 0.01, evPct: 1 }), // higher prob, lower EV
  ];
  const result = await getTodaysBestBets({ edgeCandidatesFn: edges, trendCandidatesFn: async () => [], kalshiCandidatesFn: async () => [] });
  assert.equal(result.bets.length, 2);
  assert.equal(result.bets[0].label, "A", "the higher-EV leg must rank first even though its raw probability is lower");
});

test("getTodaysBestBets excludes any candidate with negative EV — this is the whole point", async () => {
  const edges = async () => [
    edgeLeg({ label: "Good", americanOdds: -110, trueProb: 0.6, ev: 0.05, evPct: 5 }),
    edgeLeg({ label: "Bad", americanOdds: -110, trueProb: 0.4, ev: -0.24, evPct: -24 }),
  ];
  const result = await getTodaysBestBets({ edgeCandidatesFn: edges, trendCandidatesFn: async () => [], kalshiCandidatesFn: async () => [] });
  assert.equal(result.bets.length, 1);
  assert.equal(result.bets[0].label, "Good");
});

test("getTodaysBestBets computes its own EV for trend legs (which don't carry a pre-computed one)", async () => {
  // decimalOdds for -110 is ~1.909; trueProb 0.6 -> ev = 0.6*(1.909-1) - 0.4 = 0.6*0.909 - 0.4 = 0.1455 > 0
  const trends = async () => [trendLeg({ label: "Prop", americanOdds: -110, trueProb: 0.6 })];
  const result = await getTodaysBestBets({ edgeCandidatesFn: async () => [], trendCandidatesFn: trends, kalshiCandidatesFn: async () => [] });
  assert.equal(result.bets.length, 1);
  assert.ok(result.bets[0].ev > 0);
});

test("getTodaysBestBets never combines its picks into a parlay — no combined field, each bet stands alone", async () => {
  const edges = async () => [
    edgeLeg({ label: "A", americanOdds: -110, trueProb: 0.6, ev: 0.15, evPct: 15 }),
    edgeLeg({ label: "B", americanOdds: -120, trueProb: 0.62, ev: 0.1, evPct: 10, eventId: "evt-3" }),
  ];
  const result = await getTodaysBestBets({ edgeCandidatesFn: edges, trendCandidatesFn: async () => [], kalshiCandidatesFn: async () => [] });
  assert.equal(result.combined, undefined, "bestBets must never combine picks into one parlay price — that's the entire point of this module existing");
  assert.ok(Array.isArray(result.bets));
});

test("getTodaysBestBets caps at 8 recommendations even with a large positive-EV pool", async () => {
  const edges = async () =>
    Array.from({ length: 20 }, (_, i) =>
      edgeLeg({ label: `Leg ${i}`, americanOdds: -110, trueProb: 0.6, ev: 0.1 + i * 0.001, evPct: 10 + i * 0.1, eventId: `evt-cap-${i}` })
    );
  const result = await getTodaysBestBets({ edgeCandidatesFn: edges, trendCandidatesFn: async () => [], kalshiCandidatesFn: async () => [] });
  assert.equal(result.bets.length, 8);
});

test("getTodaysBestBets reports a clear note when candidates exist but none are positive EV", async () => {
  const edges = async () => [edgeLeg({ label: "Bad", americanOdds: -110, trueProb: 0.4, ev: -0.24, evPct: -24 })];
  const result = await getTodaysBestBets({ edgeCandidatesFn: edges, trendCandidatesFn: async () => [], kalshiCandidatesFn: async () => [] });
  assert.equal(result.bets.length, 0);
  assert.match(result.note, /none were positive EV/);
});

test("getTodaysBestBets reports a distinct note when there's nothing priced at all", async () => {
  const result = await getTodaysBestBets({ edgeCandidatesFn: async () => [], trendCandidatesFn: async () => [], kalshiCandidatesFn: async () => [] });
  assert.equal(result.bets.length, 0);
  assert.match(result.note, /No priced single bets available/);
});

test("getTodaysBestBets attaches a real Kelly stake percentage to each recommendation", async () => {
  const edges = async () => [edgeLeg({ label: "A", americanOdds: -110, trueProb: 0.6, ev: 0.145, evPct: 14.5 })];
  const result = await getTodaysBestBets({ edgeCandidatesFn: edges, trendCandidatesFn: async () => [], kalshiCandidatesFn: async () => [] });
  assert.equal(typeof result.bets[0].kellyStakePct, "number");
  assert.ok(result.bets[0].kellyStakePct > 0);
});

// Confirmed real motivation: the Odds API's monthly quota really does run
// out (OUT_OF_USAGE_CREDITS, seen live in server logs) and it takes down
// BOTH edgeCandidates() and trendCandidates() at once (both depend on it).
// kalshiCandidates() (Kalshi-priced moneylines, no API key or quota at
// all) is what keeps this tab from going completely empty on that day.
function kalshiLeg({ label, americanOdds, trueProb, ev, evPct, eventId = "evt-kalshi-1" }) {
  return {
    source: "kalshi",
    sport: "nfl",
    label,
    eventId,
    matchup: "EEE @ FFF",
    market: "moneyline",
    selection: label,
    americanOdds,
    decimalOdds: americanToDecimal(americanOdds),
    book: "Kalshi",
    trueProb,
    probSource: "elo-blended",
    ev,
    evPct,
    context: { kind: "edge" },
  };
}

test("getTodaysBestBets still surfaces real picks from kalshiCandidates() when both Odds-API pools are empty (the real OUT_OF_USAGE_CREDITS scenario)", async () => {
  const kalshi = async () => [kalshiLeg({ label: "Kansas City", americanOdds: -175, trueProb: 0.63, ev: 0.08, evPct: 8 })];
  const result = await getTodaysBestBets({ edgeCandidatesFn: async () => [], trendCandidatesFn: async () => [], kalshiCandidatesFn: kalshi });
  assert.equal(result.bets.length, 1);
  assert.equal(result.bets[0].source, "kalshi");
  assert.equal(result.bets[0].book, "Kalshi");
});

test("getTodaysBestBets ranks a Kalshi pick alongside Odds-API picks purely by EV, not by source", async () => {
  const edges = async () => [edgeLeg({ label: "DK pick", americanOdds: -110, trueProb: 0.55, ev: 0.02, evPct: 2 })];
  const kalshi = async () => [kalshiLeg({ label: "Kalshi pick", americanOdds: -175, trueProb: 0.63, ev: 0.08, evPct: 8 })];
  const result = await getTodaysBestBets({ edgeCandidatesFn: edges, trendCandidatesFn: async () => [], kalshiCandidatesFn: kalshi });
  assert.equal(result.bets.length, 2);
  assert.equal(result.bets[0].label, "Kalshi pick", "the higher-EV Kalshi leg must rank first regardless of source");
});
