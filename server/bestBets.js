// "Today's best bets" — a ranked list of standalone single-bet
// recommendations, built directly to answer the review's core math
// complaint about the daily longshot parlay (dailyParlay.js): stacking
// 10 favorites at ~60% each into one combined bet multiplies their
// probabilities down to under 1% combined, which is not "a confident
// day," it's a lottery ticket wearing a favorites costume — no matter how
// good each individual leg is. This module does the opposite on purpose:
// it never combines anything. Every bet here is presented, logged, and
// meant to be placed on its OWN — its own real probability, its own real
// price, its own real EV — because that is the only way a positive-EV
// pick actually stays positive-EV once you bet it.
//
// Reuses dailyParlay.js's existing candidate pool (edgeCandidates() +
// trendCandidates()) — no new ESPN/Odds-API fetch, no extra API credits —
// and simply ranks by real EV instead of stacking by raw probability
// toward an arbitrary payout target the way dailyParlay.js's favorites
// stack does.

import { edgeCandidates, trendCandidates } from "./dailyParlay.js";
import { expectedValue, kellyStake } from "./oddsMath.js";
import { localDateKey } from "./dateUtil.js";

// Only genuinely positive-EV plays qualify, full stop — the direct fix for
// "stacking favorites is not positive EV." A single bet at 0%+ EV is at
// least not a bet against yourself; this app makes no claim beyond that
// (see README's Honesty & limits — small-sample noise is real, an edge
// here is a lead to research further, not a lock).
const MIN_EV = 0;
const MAX_BEST_BETS = 8;

function withComputedEv(c) {
  // edgeCandidates() legs already carry a real, pushProb-aware EV (see
  // edges.js's makeEdge / elo.js's pushProbability) — use it as-is rather
  // than recomputing a plain EV that would silently regress that fix for
  // spread legs. trendCandidates() legs (player props, always .5 lines —
  // no push possible) don't carry one yet, so compute it here the same
  // way edges.js does for a moneyline.
  if (c.ev != null) return c;
  const ev = expectedValue(c.trueProb, c.decimalOdds);
  return { ...c, ev, evPct: ev != null ? Math.round(ev * 10000) / 100 : null };
}

/**
 * Today's real, standalone positive-EV bets — ranked by EV, never
 * combined into a parlay. `edgeCandidatesFn`/`trendCandidatesFn` are
 * injectable for testing, same pattern as dailyParlay.js's own
 * trendCandidates().
 */
export async function getTodaysBestBets({ edgeCandidatesFn = edgeCandidates, trendCandidatesFn = trendCandidates } = {}) {
  const [edges, trends] = await Promise.all([edgeCandidatesFn(), trendCandidatesFn()]);
  const allPriced = [...edges, ...trends].filter((c) => c.trueProb != null && c.decimalOdds != null).map(withComputedEv);
  const positiveEv = allPriced.filter((c) => c.ev != null && c.ev >= MIN_EV);

  const ranked = positiveEv
    .sort((a, b) => b.ev - a.ev)
    .slice(0, MAX_BEST_BETS)
    .map((c) => ({
      ...c,
      kellyStakePct: Math.round(kellyStake(c.trueProb, c.decimalOdds, 0.25) * 10000) / 100,
    }));

  return {
    date: localDateKey(),
    generatedAt: new Date().toISOString(),
    bets: ranked,
    note:
      ranked.length > 0
        ? null
        : allPriced.length > 0
          ? `Found ${allPriced.length} priced single bet(s) today, but none were positive EV — nothing honest to recommend right now. That's normal; real edges are rare. Check the Edge feed/Trends tabs directly for the full picture.`
          : "No priced single bets available today — check that ODDS_API_KEY is configured and there are games today.",
  };
}
