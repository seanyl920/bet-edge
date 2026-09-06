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

// Confirmed real bug (external review, Sept 2026): nothing rejected the
// same real-world bet appearing twice in one slip. Reproduced: 10 copies
// of one -150 pick reported as a combined +16438 at 0% EV — the naive math
// treats every leg as independent, so N copies of the same leg compound
// into a payout no sportsbook would honor (no book treats a bet against
// itself as N independent legs). Identity here is (eventId, market,
// selection) — the same real outcome, regardless of which book/price it
// happened to be added at.
function legIdentityKey(l) {
  return `${l.eventId ?? ""}|${l.market ?? ""}|${l.selection ?? ""}`;
}

export function combineLegs(legs) {
  if (!Array.isArray(legs) || legs.length === 0) {
    throw badRequest("legs must be a non-empty array");
  }

  const seenLegKeys = new Set();
  for (const l of legs) {
    const key = legIdentityKey(l);
    if (seenLegKeys.has(key)) {
      throw badRequest(`Duplicate leg: "${l.label ?? l.selection ?? key}" appears more than once — a parlay can't include the same real bet twice.`);
    }
    seenLegKeys.add(key);
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
        // Confirmed real gap: the probability above is exact, but the
        // PAYOUT it's priced against (combinedDecimalOdds below) is still
        // just the individual legs' prices multiplied together — a number
        // nobody actually quotes for this pair. A real same-game-parlay
        // product is priced by the book specifically to account for this
        // correlation, and it's normally worse (shorter) than the naive
        // product for exactly that reason — this app has no access to that
        // real combined price. correlationAdjusted.ev below is flagged as
        // hypothetical for this reason; don't treat it as a bettable number.
        correlationWarnings.push(
          `The payout used above for "${legA.label ?? legA.market}" + "${legB.label ?? legB.market}" is still just those two legs' individual prices multiplied together — not a real quoted same-game-parlay price. No book actually offers this exact combined number for a correlated pair like this (a real same-game-parlay price accounts for the correlation and is normally worse than this naive product), so the correlation-adjusted EV/odds above are illustrative of direction only, not something you can actually get down on.`
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

  // Confirmed real gap (external review, Sept 2026): each leg's best price
  // is independently line-shopped (see edges.js/trends.js), so the
  // combined price here can genuinely mix a DraftKings leg with a FanDuel
  // leg with a Caesars leg — no single sportsbook offers that exact
  // combination as one bet slip. Warn (not block) when legs span more than
  // one book, same "show the real number, flag the real caveat" pattern as
  // the correlation warnings above — an older bet logged before `book` was
  // tracked (see EdgeFeed.jsx/TrendFeed.jsx/dailyParlay.js) has `book:
  // undefined` and is excluded from this check rather than counted as a
  // mismatch against itself.
  const distinctBooks = new Set(normalized.map((l) => l.book).filter(Boolean));
  if (distinctBooks.size > 1) {
    correlationWarnings.push(
      `These legs are priced across ${distinctBooks.size} different books (${[...distinctBooks].join(", ")}) — each leg's own best price was shopped independently. No single sportsbook necessarily offers this exact combination as one placeable parlay; check that every leg is actually available at whichever book you'd place this at.`
    );
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
          // The probability is exact (see correlationWarnings for the
          // pairs it applies to); the payout it's priced against is not a
          // real quoted price — see correlationWarnings for why.
          payoutIsHypothetical: true,
          note: "Exact probability adjustment for provable same-team moneyline+spread pairs only (their real min-based joint probability, not naive multiplication) — but priced against the naive product of individual legs' odds, which is not a real quoted same-game-parlay price (see correlationWarnings). Any other same-game legs in this slip are flagged as warnings instead, since their correlation direction isn't known.",
        }
      : null,
    combinedDecimalOdds: round(combinedDecimalOdds, 3),
    combinedAmericanOdds: decimalToAmerican(combinedDecimalOdds),
    correlationWarnings,
  };
}
