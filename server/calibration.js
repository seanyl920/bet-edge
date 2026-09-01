// Turns graded postmortems into real, empirical hit rates — the actual
// "learning" mechanism in this app. No black-box model: it's a frequency
// table, bucketed by (sport, trend type, score) for trend legs and by
// (sport, market, model-probability decile) for edge-feed legs, computed
// fresh from your own bet log every time it's asked for.
//
// A bucket only "counts" (gets used to influence ranking) once it has at
// least MIN_SAMPLE graded legs — below that, a couple of lucky/unlucky bets
// could swing an apparent hit rate wildly, which is worse than just showing
// the heuristic score honestly labeled as unproven.

import { listBets } from "./betlog.js";

const MIN_SAMPLE = 15;

function scoreBucketLabel(score) {
  if (score == null) return "unknown";
  const lo = Math.floor(score / 3) * 3;
  return `${lo}-${lo + 2}`;
}

function probDecileLabel(prob) {
  if (prob == null) return "unknown";
  const d = Math.min(9, Math.max(0, Math.floor(prob * 10)));
  return `${d * 10}-${d * 10 + 9}%`;
}

function trendKey(sport, trendType, score) {
  return `trend:${sport}:${trendType}:${scoreBucketLabel(score)}`;
}

function edgeKey(sport, market, prob) {
  return `edge:${sport}:${market}:${probDecileLabel(prob)}`;
}

/** Rebuilds the full calibration table from every graded bet in the log. */
export async function getCalibration() {
  const bets = await listBets();
  const buckets = new Map();

  for (const bet of bets) {
    if (!bet.postmortem?.legs?.length || !Array.isArray(bet.legs)) continue;
    bet.legs.forEach((leg, i) => {
      const result = bet.postmortem.legs[i];
      if (!result || result.hit == null) return;

      const ctx = leg.context ?? {};
      const sport = leg.sport ?? bet.sport;
      let key, label;
      if (ctx.kind === "trend") {
        key = trendKey(sport, ctx.trendType, ctx.score);
        label = `${String(sport).toUpperCase()} ${ctx.trendType} · score ${scoreBucketLabel(ctx.score)}`;
      } else if (ctx.kind === "edge") {
        key = edgeKey(sport, leg.market, ctx.modelProb);
        label = `${String(sport).toUpperCase()} ${leg.market} · model ${probDecileLabel(ctx.modelProb)}`;
      } else {
        return;
      }

      const bucket = buckets.get(key) ?? { key, label, n: 0, hits: 0 };
      bucket.n += 1;
      if (result.hit) bucket.hits += 1;
      buckets.set(key, bucket);
    });
  }

  const table = [...buckets.values()]
    .map((b) => ({
      ...b,
      hitRatePct: Math.round((b.hits / b.n) * 1000) / 10,
      calibrated: b.n >= MIN_SAMPLE,
    }))
    .sort((a, b) => b.n - a.n);

  return { minSample: MIN_SAMPLE, buckets: table };
}

/** Look up a calibrated rate for one trend, given an already-fetched calibration table (avoids recomputing per trend). */
export function lookupTrendCalibration(buckets, sport, trendType, score) {
  const key = trendKey(sport, trendType, score);
  const bucket = buckets.find((b) => b.key === key);
  if (!bucket || !bucket.calibrated) return null;
  return { rate: bucket.hitRatePct / 100, n: bucket.n };
}
