// Parlay combination with a same-game-correlation warning layered on top of
// the naive independent-legs math. This is a heuristic, not a copula model —
// it exists so the app never quietly overstates a same-game parlay's real
// probability the way naive multiplication does.

import { americanToDecimal, decimalToAmerican, expectedValue, round } from "./oddsMath.js";

// Rough haircut applied to combined probability per extra leg sharing an
// event with another leg already in the slip. Same-game legs are usually
// positively correlated (e.g. favorite ML + favorite -spread + game Under
// tend to move together), so naive multiplication overstates the true hit
// rate; this knocks it down. It's a blunt correction, not a fitted one —
// shown alongside the naive number so you can judge for yourself.
const SAME_GAME_HAIRCUT = 0.85;

export function combineLegs(legs) {
  if (!Array.isArray(legs) || legs.length === 0) {
    const err = new Error("legs must be a non-empty array");
    err.status = 400;
    throw err;
  }

  const normalized = legs.map((l, i) => {
    const decimalOdds = l.decimalOdds ?? americanToDecimal(l.americanOdds);
    if (decimalOdds == null || l.trueProb == null) {
      const err = new Error(`leg ${i} needs trueProb and either decimalOdds or americanOdds`);
      err.status = 400;
      throw err;
    }
    return { ...l, decimalOdds, trueProb: Number(l.trueProb) };
  });

  const naiveProb = normalized.reduce((acc, l) => acc * l.trueProb, 1);
  const combinedDecimalOdds = normalized.reduce((acc, l) => acc * l.decimalOdds, 1);

  // Count legs beyond the first that share an eventId with an earlier leg.
  const seenEvents = new Set();
  let correlatedExtraLegs = 0;
  const correlationWarnings = [];
  for (const leg of normalized) {
    if (leg.eventId && seenEvents.has(leg.eventId)) {
      correlatedExtraLegs += 1;
      correlationWarnings.push(
        `"${leg.label ?? leg.market ?? "leg"}" shares an event with another leg in this slip — same-game correlation likely overstates the naive probability.`
      );
    }
    if (leg.eventId) seenEvents.add(leg.eventId);
  }

  const adjustedProb = naiveProb * SAME_GAME_HAIRCUT ** correlatedExtraLegs;

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
    correlationAdjusted:
      correlatedExtraLegs > 0
        ? {
            trueProb: round(adjustedProb),
            americanOdds: decimalToAmerican(combinedDecimalOdds),
            ev: round(expectedValue(adjustedProb, combinedDecimalOdds)),
            note: "Heuristic haircut for same-game legs, not a fitted correlation model. Treat as a more conservative estimate, not a precise one.",
          }
        : null,
    combinedDecimalOdds: round(combinedDecimalOdds, 3),
    combinedAmericanOdds: decimalToAmerican(combinedDecimalOdds),
    correlationWarnings,
  };
}
