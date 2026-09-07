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
// stack does. Also pulls in kalshiCandidates() (Kalshi-priced moneylines,
// see kalshiEdges.js) — confirmed live to need no API key and carry no
// monthly quota, unlike the Odds-API-backed pools above, so this tab
// isn't fully dead on a day the Odds API quota runs out (a real,
// confirmed thing that happens — see OUT_OF_USAGE_CREDITS in server logs).

import { edgeCandidates, trendCandidates } from "./dailyParlay.js";
import { getKalshiEdgeFeed } from "./kalshiEdges.js";
import { SPORTS } from "./sports.js";
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

function pctStr(p) {
  return p == null ? "—" : `${Math.round(p * 100)}%`;
}

/**
 * Kalshi-priced moneyline candidates, today's games only — the point of
 * pulling this in here specifically: it has NO Odds-API quota dependency
 * at all (confirmed live — see kalshiApi.js's header), so this keeps
 * "today's best bets" from going completely empty on a day the Odds API
 * quota is exhausted (a real thing that's happened this app — see
 * OUT_OF_USAGE_CREDITS in the server logs), for whichever sports have a
 * confirmed Kalshi game series. `getKalshiEdgeFeedFn` is injectable for
 * testing, same pattern as edgeCandidates()/trendCandidates().
 */
async function kalshiCandidates({ getKalshiEdgeFeedFn = getKalshiEdgeFeed } = {}) {
  const out = [];
  for (const sport of Object.values(SPORTS)) {
    if (!sport.kalshiGameSeries) continue;
    try {
      const { edges, available } = await getKalshiEdgeFeedFn(sport, { threshold: -1 });
      if (!available) continue;
      const todaysEdges = edges.filter((e) => localDateKey(e.commenceTime) === localDateKey());
      for (const e of todaysEdges) {
        out.push({
          source: "kalshi",
          sport: sport.key,
          label: `${e.team} (moneyline)`,
          eventId: e.eventId,
          matchup: e.matchup,
          commenceTime: e.commenceTime,
          market: e.market,
          selection: e.team,
          americanOdds: e.americanOdds,
          book: e.book,
          trueProb: e.blendedProb,
          probSource: "elo-blended",
          decimalOdds: e.decimalOdds,
          // makeKalshiEdge() already computes this — see the matching
          // comment on withComputedEv for why this must be used as-is.
          ev: e.ev,
          evPct: e.evPct,
          reason: `Elo (${e.sampleSize}-game sample) has ${e.team} at ${pctStr(e.modelProb)}, Kalshi ${pctStr(e.marketProb)} — blended to ${pctStr(e.blendedProb)}.`,
          context: {
            kind: "edge",
            side: e.side,
            team: e.team,
            line: null,
            modelProb: e.blendedProb,
            rawEloProb: e.modelProb,
            marketProb: e.marketProb,
            sampleSize: e.sampleSize,
          },
        });
      }
    } catch (err) {
      // one sport's Kalshi feed failing (rate-limited, network) shouldn't
      // sink the whole build — same policy as edgeCandidates() above.
    }
  }
  return out;
}

/**
 * Today's real, standalone positive-EV bets — ranked by EV, never
 * combined into a parlay. `edgeCandidatesFn`/`trendCandidatesFn`/
 * `kalshiCandidatesFn` are injectable for testing, same pattern as
 * dailyParlay.js's own trendCandidates().
 */
export async function getTodaysBestBets({
  edgeCandidatesFn = edgeCandidates,
  trendCandidatesFn = trendCandidates,
  kalshiCandidatesFn = kalshiCandidates,
} = {}) {
  const [edges, trends, kalshi] = await Promise.all([edgeCandidatesFn(), trendCandidatesFn(), kalshiCandidatesFn()]);
  const allPriced = [...edges, ...trends, ...kalshi].filter((c) => c.trueProb != null && c.decimalOdds != null).map(withComputedEv);
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
          : "No priced single bets available today — check that ODDS_API_KEY is configured (and hasn't run out of monthly quota), that Kalshi's API is reachable, and that there are games today.",
  };
}
