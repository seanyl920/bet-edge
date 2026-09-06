// Poisson-based probability model for count-type MLB props. Currently
// covers pitcher strikeouts only — the one count prop this app already has
// real, per-game exposure (innings pitched) and outcome (strikeouts) data
// for, via mlbData.js's getPitcherGameLog().
//
// This exists to answer a real gap raised by external review (Sept 2026):
// every prop probability this app produces elsewhere (trends.js) comes
// from either a devigged market line or this app's own graded-history
// calibration — never from an actual statistical model of the underlying
// count. Devig/calibration both need a real market line or real graded
// volume to exist at all; a genuine distributional model can price a line
// this app has never seen graded before, from first principles.
//
// Why Poisson specifically: strikeouts in one start are a count of
// successes over a number of at-bats faced — the textbook use case for a
// Poisson (or negative-binomial) count distribution. lambda (expected
// strikeouts) is built ENTIRELY from this pitcher's own real, already-
// fetched game log — a rolling innings-pitched average (the exposure)
// times a rolling strikeouts-per-inning rate. No invented inputs.
//
// Known, disclosed limitation (not fabricated away, per this project's
// standing rule against inventing numbers to fill gaps): real strikeout
// counts run somewhat overdispersed relative to a pure Poisson (variance
// a bit above the mean) — well documented in public sabermetrics writing.
// A negative-binomial refinement would need a dispersion parameter FIT to
// this app's own graded history, which doesn't exist yet in real volume.
// Rather than invent one, this stays plain Poisson and says so — the same
// "baseline, not finished" framing this project already uses for its Elo
// model (see README's Honesty & limits). This is presented as an
// ADDITIONAL, separately-tracked probability (its own `probSource`,
// logged and graded like anything else — see predictionLog.js/
// predictionEval.js) — never substituted in as the price a real bet uses
// until it has its own real, evaluated track record. See modelRegistry.js
// for exactly how that promotion decision is made (and that it's never
// automatic).

/** P(X = k) for X ~ Poisson(lambda), computed iteratively (pmf(k) = pmf(k-1) * lambda/k) to avoid factorial overflow. */
export function poissonPmf(k, lambda) {
  if (!Number.isInteger(k) || k < 0 || !(lambda >= 0)) return null;
  if (lambda === 0) return k === 0 ? 1 : 0;
  let pmf = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) pmf *= lambda / i;
  return pmf;
}

/** P(X <= k) for X ~ Poisson(lambda). */
export function poissonCdf(k, lambda) {
  if (!Number.isInteger(k) || k < 0 || !(lambda >= 0)) return null;
  let cdf = Math.exp(-lambda);
  let term = cdf;
  for (let i = 1; i <= k; i++) {
    term *= lambda / i;
    cdf += term;
  }
  return Math.min(1, cdf);
}

const MIN_STARTS = 3; // fewer than this and a rolling rate is just noise — return null, never guess
const MAX_LOOKBACK = 8; // recent-form window — deliberately short; a pitcher's true-talent K rate this season can drift (velocity, role, health)

/**
 * Expected strikeouts (lambda) for a pitcher's next start, from his own
 * real recent game log alone.
 * @param {Array<{SO: number, IP: number}>} gameLog - most-recent-first, same shape getPitcherGameLog() returns
 * @returns {{lambda: number, avgIP: number, kPerIP: number, starts: number} | null} null when there isn't enough real data to trust
 */
export function expectedStrikeouts(gameLog) {
  if (!Array.isArray(gameLog)) return null;
  const starts = gameLog.filter((g) => Number.isFinite(g?.SO) && Number.isFinite(g?.IP) && g.IP > 0).slice(0, MAX_LOOKBACK);
  if (starts.length < MIN_STARTS) return null;

  const totalIP = starts.reduce((s, g) => s + g.IP, 0);
  const totalSO = starts.reduce((s, g) => s + g.SO, 0);
  const kPerIP = totalSO / totalIP;
  const avgIP = totalIP / starts.length;
  return { lambda: round4(avgIP * kPerIP), avgIP: round4(avgIP), kPerIP: round4(kPerIP), starts: starts.length };
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

/**
 * Over/Under probabilities for a specific strikeout line, given lambda.
 * Prop lines are essentially always X.5 (books avoid an exact integer line
 * here specifically to avoid a push) — Over means strictly more than
 * `line`, i.e. SO >= floor(line) + 1. An integer line is handled correctly
 * too (Over/Under leave out the exact-line probability, which is real and
 * returned separately as `pushProb` — same "don't silently drop a push"
 * principle as elo.js's pushProbability for spreads).
 */
export function poissonPropProbabilities(lambda, line) {
  if (lambda == null || line == null || !(lambda >= 0)) return null;
  const isIntegerLine = Number.isInteger(line);
  const atOrBelow = Math.floor(line); // for a X.5 line this IS "at or below the number that misses the Over"
  const overProb = 1 - poissonCdf(atOrBelow, lambda);
  if (!isIntegerLine) {
    return { over: round4(overProb), under: round4(1 - overProb), pushProb: 0 };
  }
  // Integer line: exact equality is a real push (refund), not a win or loss
  // for either side.
  const pushProb = poissonPmf(line, lambda);
  const strictOverProb = 1 - poissonCdf(line, lambda);
  const strictUnderProb = poissonCdf(line - 1, lambda);
  return { over: round4(strictOverProb), under: round4(strictUnderProb), pushProb: round4(pushProb) };
}
