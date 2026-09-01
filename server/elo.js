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

const BASE_RATING = 1500;

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
    return this.ratings.get(teamId) ?? BASE_RATING;
  }

  getGameCount(teamId) {
    return this.gamesCounted.get(teamId) ?? 0;
  }

  /** Fold one final, completed game into the ratings. Games must be applied in date order. */
  applyResult({ homeTeamId, awayTeamId, homeScore, awayScore }) {
    const homeRating = this.getRating(homeTeamId);
    const awayRating = this.getRating(awayTeamId);
    const eloDiff = homeRating - awayRating + this.hfa;
    const expectedHome = eloDiffToWinProb(eloDiff);

    const homeWon = homeScore > awayScore;
    const margin = Math.abs(homeScore - awayScore);
    const actualHome = homeScore === awayScore ? 0.5 : homeWon ? 1 : 0;

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
