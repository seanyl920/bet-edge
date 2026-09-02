// Parlay combination. The naive number (independent-legs math) is always
// shown — it's simple and its assumption (independence) is stated plainly.
// On top of it, this looks for the one same-game relationship that can be
// proven exactly rather than guessed at: a team's own moneyline and spread
// in the same game aren't independent — one logically implies the other —
// so their real joint probability is min(p_ml, p_spread), not the naive
// product. Any other same-game combination gets a warning, not a number:
// see README's Known-issue history for why an earlier version of this file
// applied a flat "always shrink by 15%" haircut to every same-game
// combination regardless of direction, which was provably backwards for
// exactly the moneyline+spread case this file now handles correctly.

import { americanToDecimal, decimalToAmerican, expectedValue, round } from "./oddsMath.js";

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

export function combineLegs(legs) {
  if (!Array.isArray(legs) || legs.length === 0) {
    throw badRequest("legs must be a non-empty array");
  }

  const normalized = legs.map((l, i) => {
    const decimalOdds = l.decimalOdds ?? americanToDecimal(l.americanOdds);
    if (decimalOdds == null || l.trueProb == null) {
      throw badRequest(`leg ${i} needs trueProb and either decimalOdds or americanOdds`);
    }
    const trueProb = Number(l.trueProb);
    if (!Number.isFinite(trueProb) || trueProb < 0 || trueProb > 1) {
      throw badRequest(`leg ${i}'s trueProb (${l.trueProb}) must be a finite number between 0 and 1`);
    }
    if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) {
      throw badRequest(`leg ${i}'s decimal odds (${decimalOdds}) must be a finite number greater than 1`);
    }
    return { ...l, decimalOdds, trueProb };
  });

  const naiveProb = normalized.reduce((acc, l) => acc * l.trueProb, 1);
  const combinedDecimalOdds = normalized.reduce((acc, l) => acc * l.decimalOdds, 1);

  const byEvent = new Map();
  normalized.forEach((leg, idx) => {
    if (!leg.eventId) return;
    const arr = byEvent.get(leg.eventId) ?? [];
    arr.push(idx);
    byEvent.set(leg.eventId, arr);
  });

  const correlationWarnings = [];
  const usedIdx = new Set();
  let adjustedProb = naiveProb;
  let hasExactAdjustment = false;

  for (const indices of byEvent.values()) {
    if (indices.length < 2) continue;

    // The one relationship this app can prove exactly: same team's
    // moneyline and spread in one game. A favorite covering implies
    // winning outright; an underdog winning outright implies covering any
    // positive spread. Either way, one event is a strict subset of the
    // other, so P(both) = min(P(each)) — not their product.
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const ia = indices[a];
        const ib = indices[b];
        if (usedIdx.has(ia) || usedIdx.has(ib)) continue;
        const legA = normalized[ia];
        const legB = normalized[ib];
        const teamA = legA.context?.team ?? legA.context?.side ?? null;
        const teamB = legB.context?.team ?? legB.context?.side ?? null;
        const isMlSpreadPair =
          teamA != null &&
          teamA === teamB &&
          ((legA.market === "moneyline" && legB.market === "spread") ||
            (legA.market === "spread" && legB.market === "moneyline"));
        if (!isMlSpreadPair) continue;

        const naiveFactor = legA.trueProb * legB.trueProb;
        const jointProb = Math.min(legA.trueProb, legB.trueProb);
        if (naiveFactor > 0) {
          adjustedProb = (adjustedProb / naiveFactor) * jointProb;
          hasExactAdjustment = true;
        }
        usedIdx.add(ia);
        usedIdx.add(ib);
        correlationWarnings.push(
          `"${legA.label ?? legA.market}" and "${legB.label ?? legB.market}" are the same team's moneyline and spread in one game — not independent (one implies the other), so their exact combined probability (${round(jointProb * 100, 1)}%) replaces naive multiplication for this pair.`
        );
      }
    }

    // Anything left sharing this event has no proven relationship — either
    // 2+ legs with nothing resolved between them, or 1 leftover leg that
    // still shares the event with a pair that WAS resolved above. Same-game
    // correlation could push the real probability either above or below
    // the naive number depending on which markets are involved, so no
    // numeric adjustment is applied here, only a warning.
    const unresolved = indices.filter((i) => !usedIdx.has(i));
    const anyResolvedHere = unresolved.length < indices.length;
    if (unresolved.length >= 2 || (unresolved.length === 1 && anyResolvedHere)) {
      correlationWarnings.push(
        `${unresolved.length} leg(s) sharing this game don't have a provable relationship in this app — same-game correlation could make the real probability higher OR lower than naive multiplication suggests, not just lower. Treat the naive number here as a rough reference, not a bound.`
      );
    }
  }

  return {
    legs: normalized.map((l) => ({
      label: l.label ?? null,
      eventId: l.eventId ?? null,
      trueProb: round(l.trueProb),
      americanOdds: l.americanOdds ?? decimalToAmerican(l.decimalOdds),
    })),
    naive: {
      trueProb: round(naiveProb),
      americanOdds: decimalToAmerican(combinedDecimalOdds),
      ev: round(expectedValue(naiveProb, combinedDecimalOdds)),
    },
    correlationAdjusted: hasExactAdjustment
      ? {
          trueProb: round(adjustedProb),
          americanOdds: decimalToAmerican(combinedDecimalOdds),
          ev: round(expectedValue(adjustedProb, combinedDecimalOdds)),
          note: "Exact adjustment for provable same-team moneyline+spread pairs only (their real min-based joint probability, not naive multiplication). Any other same-game legs in this slip are flagged as warnings instead, since their correlation direction isn't known — see correlationWarnings.",
        }
      : null,
    combinedDecimalOdds: round(combinedDecimalOdds, 3),
    combinedAmericanOdds: decimalToAmerican(combinedDecimalOdds),
    correlationWarnings,
  };
}
