// Pure odds math: American <-> decimal <-> implied probability, devigging,
// parlay combination, EV, and Kelly staking. No I/O in this file — easy to
// unit-test by hand and easy to trust.

/** American odds (e.g. -110, +150) -> decimal odds (e.g. 1.909, 2.5). */
export function americanToDecimal(american) {
  const a = Number(american);
  if (!Number.isFinite(a) || a === 0) return null;
  return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
}

/** Decimal odds -> American odds. */
export function decimalToAmerican(decimal) {
  const d = Number(decimal);
  if (!Number.isFinite(d) || d <= 1) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

/** Decimal odds -> naive implied probability (includes the book's vig). */
export function decimalToImpliedProb(decimal) {
  const d = Number(decimal);
  if (!Number.isFinite(d) || d <= 1) return null;
  return 1 / d;
}

/**
 * Remove the vig from a set of same-market outcomes (e.g. home/away moneyline,
 * or over/under) using simple multiplicative normalization: each outcome's
 * raw implied probability is scaled so the set sums to 1. This is an
 * approximation (it doesn't correct for favorite-longshot bias the way the
 * Shin method does) but it's transparent and good enough to flag edges.
 *
 * @param {number[]} decimalOdds - decimal odds for every outcome in the market
 * @returns {number[]} fair (devigged) probabilities, same order, summing to 1
 */
export function devigMultiplicative(decimalOdds) {
  const raw = decimalOdds.map(decimalToImpliedProb);
  if (raw.some((p) => p == null)) return raw.map(() => null);
  const total = raw.reduce((sum, p) => sum + p, 0);
  if (!(total > 0)) return raw.map(() => null);
  return raw.map((p) => p / total);
}

/** The overround/vig baked into a market, as a fraction (e.g. 0.045 = 4.5%). */
export function marketVig(decimalOdds) {
  const raw = decimalOdds.map(decimalToImpliedProb);
  if (raw.some((p) => p == null)) return null;
  return raw.reduce((sum, p) => sum + p, 0) - 1;
}

/**
 * Expected value of a single bet, as a fraction of stake.
 * @param {number} trueProb - your model's win probability for the side you'd bet
 * @param {number} decimalOdds - the price you'd actually get (best line shopped)
 */
export function expectedValue(trueProb, decimalOdds) {
  if (trueProb == null || decimalOdds == null) return null;
  return trueProb * (decimalOdds - 1) - (1 - trueProb);
}

/**
 * Fractional Kelly stake as a fraction of bankroll. Returns 0 for -EV bets.
 * @param {number} fraction - Kelly fraction to use (1 = full Kelly, 0.25 = quarter Kelly)
 */
export function kellyStake(trueProb, decimalOdds, fraction = 0.25) {
  if (trueProb == null || decimalOdds == null) return 0;
  const b = decimalOdds - 1;
  if (b <= 0) return 0;
  const f = (trueProb * b - (1 - trueProb)) / b;
  return Math.max(0, f * fraction);
}

/** Standard normal CDF via the Abramowitz-Stegun approximation (no deps). */
export function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let p =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}

/** Middle value of a numeric array — more robust than a mean against one stale/outlier book. */
export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function round(n, digits = 4) {
  if (n == null || !Number.isFinite(n)) return null;
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}
