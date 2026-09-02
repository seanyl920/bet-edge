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

// Confirmed real bug: this key never included the bet's side (Over/Under) —
// a graded "Under" leg and a graded "Over" leg on the same trend type could
// land in the same bucket if their score happened to fall in the same band,
// even though they're opposite predictions. 15 winning Under bets would
// produce a 100% "hit rate" this app could then hand straight to an Over
// pick. Every trend this app generates is framed as "Over" (see trends.js),
// but a user can still manually add an Under from the odds list — so the
// key has to account for it, not assume it never happens.
function trendKey(sport, trendType, side, score) {
  const sideKey = side ? String(side).toLowerCase() : "unknown";
  return `trend:${sport}:${trendType}:${sideKey}:${scoreBucketLabel(score)}`;
}

function edgeKey(sport, market, prob) {
  return `edge:${sport}:${market}:${probDecileLabel(prob)}`;
}

// Confirmed real bug: the score-bucketed key above is fine for RANKING a
// trend before any specific line is known (that's all trends.js's ranking
// step has to go on), but dailyParlay.js and TrendFeed.jsx were also using
// that same score-bucketed rate as the actual probability priced against a
// SPECIFIC prop line — and score has nothing to do with the threshold. 15
// graded "Over 2.5 K" bets and a completely different "Over 8.5 K" line
// could land in the same score band and share a rate, overriding that
// line's real ~18.9% market-implied probability with an unrelated bucket's
// 100%. A specific bet's real identity is (sport, trend type, side,
// threshold) — not score — so pricing needs its own key keyed on the
// threshold instead, kept separate from the ranking bucket above.
function trendPointKey(sport, trendType, side, point) {
  const sideKey = side ? String(side).toLowerCase() : "unknown";
  const pointKey = point != null ? String(point) : "unknown";
  return `trendpoint:${sport}:${trendType}:${sideKey}:${pointKey}`;
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
      const keys = []; // a leg can bump more than one bucket (ranking + pricing, for a trend leg)
      if (ctx.kind === "trend") {
        keys.push([
          trendKey(sport, ctx.trendType, ctx.propSide, ctx.score),
          `${String(sport).toUpperCase()} ${ctx.trendType} ${ctx.propSide ?? ""} · score ${scoreBucketLabel(ctx.score)}`,
        ]);
        // Only bump the point-specific pricing bucket when the graded leg
        // actually has a point — an older bet or a non-prop trend leg
        // might not.
        if (ctx.propPoint != null) {
          keys.push([
            trendPointKey(sport, ctx.trendType, ctx.propSide, ctx.propPoint),
            `${String(sport).toUpperCase()} ${ctx.trendType} ${ctx.propSide ?? ""} ${ctx.propPoint}`,
          ]);
        }
      } else if (ctx.kind === "edge") {
        keys.push([
          edgeKey(sport, leg.market, ctx.modelProb),
          `${String(sport).toUpperCase()} ${leg.market} · model ${probDecileLabel(ctx.modelProb)}`,
        ]);
      } else {
        return;
      }

      for (const [key, label] of keys) {
        const bucket = buckets.get(key) ?? { key, label, n: 0, hits: 0 };
        bucket.n += 1;
        if (result.hit) bucket.hits += 1;
        buckets.set(key, bucket);
      }
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

/** Look up a calibrated rate for one trend, given an already-fetched calibration table (avoids recomputing per trend). Score-bucketed — for RANKING a trend before any specific line is chosen, never for pricing a specific bet (see lookupTrendPointCalibration for that). */
export function lookupTrendCalibration(buckets, sport, trendType, side, score) {
  const key = trendKey(sport, trendType, side, score);
  const bucket = buckets.find((b) => b.key === key);
  if (!bucket || !bucket.calibrated) return null;
  return { rate: bucket.hitRatePct / 100, n: bucket.n };
}

/** Look up a calibrated rate for one SPECIFIC prop line (sport, trend type, side, threshold) — the real identity of a bet, for pricing it, not the coarser score-bucketed rate above. */
export function lookupTrendPointCalibration(buckets, sport, trendType, side, point) {
  const key = trendPointKey(sport, trendType, side, point);
  const bucket = buckets.find((b) => b.key === key);
  if (!bucket || !bucket.calibrated) return null;
  return { rate: bucket.hitRatePct / 100, n: bucket.n };
}
