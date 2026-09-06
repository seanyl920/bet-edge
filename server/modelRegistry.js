// The concrete "challenger/promote" mechanism behind this project's
// prospective-evaluation infrastructure. A new probability source (e.g.
// propModel.js's Poisson strikeout model, tagged probSource "poisson") is
// never used to price a real bet on day one — it's logged and graded
// exactly like anything else in predictionLog.js/predictionEval.js, under
// its own probSource, running alongside (never replacing) whatever
// currently prices that bet.
//
// This module answers exactly one question, honestly: given enough real,
// matched, graded predictions, does this probability source actually beat
// the devigged market? It NEVER flips what prices a real bet by itself —
// that decision is a human reading this recommendation and deciding to
// wire a new probSource into the pricing path (trends.js/edges.js), the
// same way every other model change in this app has been made. Automating
// that flip would mean the app silently starts pricing real-money bets off
// a model whose "it's better" claim came from itself — precisely the trap
// this project's standing instructions (never claim improved accuracy
// without evidence) exist to avoid.

// Matched-comparison rows needed before ANY promotion claim is even
// considered. Not tuned to this app's own data (there isn't enough graded
// volume yet to tune it against) — chosen as a round, conservative number:
// large enough that a handful of lucky/unlucky outcomes can't flip the
// verdict, small enough to be reachable for a single-user tool without
// waiting years. Revisit once real volume exists to justify a different one.
export const MIN_PROMOTION_N = 30;

/**
 * @param {{comparison: {n: number, modelBrierScore: number|null, marketBrierScore: number|null}}} group - one entry from predictionEval.js's `groups`
 * @returns {{promotable: boolean, reason: string}}
 */
export function promotionStatus(group) {
  const comparison = group?.comparison;
  const n = comparison?.n ?? 0;
  if (n < MIN_PROMOTION_N) {
    return {
      promotable: false,
      reason: `needs ${MIN_PROMOTION_N - n} more matched, graded prediction(s) before this can be evaluated at all (n=${n})`,
    };
  }
  if (comparison.modelBrierScore == null || comparison.marketBrierScore == null) {
    return { promotable: false, reason: "missing a Brier score to compare against the market" };
  }
  if (comparison.modelBrierScore <= comparison.marketBrierScore) {
    return {
      promotable: true,
      reason: `beats (or ties) the devigged market's Brier score over ${n} matched, graded predictions — a real candidate to start pricing real bets with, if you decide to wire it in`,
    };
  }
  return { promotable: false, reason: `still worse than the devigged market's Brier score over ${n} matched, graded predictions` };
}
