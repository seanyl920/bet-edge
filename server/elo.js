// Elo rating engine. This is a deliberately simple baseline model — a
// starting point for finding market mispricing, not a finished predictive
// system. It knows nothing about injuries, pace, matchups, or coaching; it
// only reacts to final scores and home-court/field advantage.
//
// Methodology follows the shape of FiveThirtyEight's public NFL/NBA Elo
// writeups: a K-factor update scaled by a margin-of-victory multiplier that
// tapers off as the pre-game rating gap grows (to avoid over-crediting blowouts
// against already-weak teams), plus a fixed home-field/court advantage.

import { normalCdf } from "./oddsMath.js";

export const BASE_RATING = 1500;

export function eloDiffToWinProb(eloDiff) {
  return 1 / (1 + 10 ** (-eloDiff / 400));
}

/** Rough expected scoring margin implied by an Elo gap (already includes HFA). */
export function eloDiffToExpectedMargin(eloDiff, pointsPerElo) {
  return eloDiff / pointsPerElo;
}

/**
 * Probability the home side covers a market spread, using the Elo-implied
 * expected margin and a normal approximation of final-margin variance.
 * `marketSpreadHome` is the home team's spread in the usual convention
 * (negative = home favored by that many points).
 */
export function coverProbability({ expectedMarginHome, marketSpreadHome, marginSigma }) {
  // Home "covers" if actual margin > -marketSpreadHome.
  const threshold = -marketSpreadHome;
  const z = (expectedMarginHome - threshold) / marginSigma;
  return normalCdf(z);
}

function movMultiplier(marginAbs, eloDiffWinner) {
  // FiveThirtyEight-style margin-of-victory dampener: bigger blowouts move
  // the rating more, but a big win against a team you were already heavily
  // favored over moves it less than the same blowout in a coin-flip game.
  return Math.log(Math.max(marginAbs, 1) + 1) * (2.2 / (eloDiffWinner * 0.001 + 2.2));
}

export class EloEngine {
  constructor({ k, homeFieldAdvantage, pointsPerElo, marginSigma }) {
    this.k = k;
    this.hfa = homeFieldAdvantage;
    this.pointsPerElo = pointsPerElo;
    this.marginSigma = marginSigma;
    this.ratings = new Map(); // teamId -> rating
    this.gamesCounted = new Map(); // teamId -> number of games folded in
  }

  getRating(teamId) {
    const r = this.ratings.get(teamId);
    // `?? BASE_RATING` alone only falls back for a missing entry
    // (null/undefined) — a real confirmed bug: if a rating ever gets set to
    // an actual NaN (e.g. from one malformed score elsewhere in the season,
    // or a bad carryover seed), `??` lets that NaN straight through, and it
    // silently spreads to every team that plays them from then on (their
    // updated rating is also NaN, then THEIR next opponent's, etc.) — one
    // bad game can quietly poison an entire league's predictions over a
    // season. Number.isFinite() catches NaN too, so this self-heals: a
    // corrupted entry is treated the same as a missing one instead of
    // propagating. See README's Known-issue history.
    return Number.isFinite(r) ? r : BASE_RATING;
  }

  getGameCount(teamId) {
    return this.gamesCounted.get(teamId) ?? 0;
  }

  /** Fold one final, completed game into the ratings. Games must be applied in date order. */
  applyResult({ homeTeamId, awayTeamId, homeScore, awayScore, eventId }) {
    // `Number(null)` is 0, not NaN — coercing null/undefined straight to
    // Number() would let a missing score silently become a real 0-0 game
    // instead of getting rejected. Force those to NaN first so the finite
    // check below actually catches them.
    const home = homeScore == null ? NaN : Number(homeScore);
    const away = awayScore == null ? NaN : Number(awayScore);
    if (!Number.isFinite(home) || !Number.isFinite(away)) {
      // Never let a bad score value write NaN into a rating — that's the
      // actual source of the contamination getRating() above defends
      // against. Reject it here instead, so it never has a chance to
      // spread in the first place.
      console.warn(
        `[elo] applyResult: non-finite score (home=${homeScore}, away=${awayScore}) for event ${eventId ?? "unknown"} — skipped rather than corrupt ${homeTeamId}/${awayTeamId}'s ratings.`
      );
      return;
    }

    const homeRating = this.getRating(homeTeamId);
    const awayRating = this.getRating(awayTeamId);
    const eloDiff = homeRating - awayRating + this.hfa;
    const expectedHome = eloDiffToWinProb(eloDiff);

    const homeWon = home > away;
    const margin = Math.abs(home - away);
    const actualHome = home === away ? 0.5 : homeWon ? 1 : 0;

    const winnerEloDiff = homeWon ? eloDiff : -eloDiff;
    const mult = margin === 0 ? 1 : movMultiplier(margin, Math.max(winnerEloDiff, 0));

    const delta = this.k * mult * (actualHome - expectedHome);
    this.ratings.set(homeTeamId, homeRating + delta);
    this.ratings.set(awayTeamId, awayRating - delta);
    this.gamesCounted.set(homeTeamId, this.getGameCount(homeTeamId) + 1);
    this.gamesCounted.set(awayTeamId, this.getGameCount(awayTeamId) + 1);
  }

  /** Model win probability + expected margin for an upcoming game, home team's perspective. */
  predict({ homeTeamId, awayTeamId }) {
    const homeRating = this.getRating(homeTeamId);
    const awayRating = this.getRating(awayTeamId);
    const eloDiff = homeRating - awayRating + this.hfa;
    return {
      homeElo: homeRating,
      awayElo: awayRating,
      eloDiff,
      homeWinProb: eloDiffToWinProb(eloDiff),
      awayWinProb: 1 - eloDiffToWinProb(eloDiff),
      expectedMarginHome: eloDiffToExpectedMargin(eloDiff, this.pointsPerElo),
      marginSigma: this.marginSigma,
      // Games actually folded into these two teams' current ratings — a
      // rough confidence signal. Early season = thin sample = trust less.
      sampleSize: Math.min(this.getGameCount(homeTeamId), this.getGameCount(awayTeamId)),
    };
  }
}
