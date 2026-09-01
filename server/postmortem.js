// Grades a settled bet's legs against what actually happened, using the
// snapshot captured at bet time (see the `context` field the frontend
// attaches in EdgeFeed.jsx/TrendFeed.jsx). This is the "feed a miss back to
// it" loop: every graded leg becomes a data point calibration.js can later
// aggregate into real hit rates.
//
// A leg that can't be graded (game not final, missing snapshot data from an
// older bet, ESPN hiccup) comes back with hit: null and a note explaining
// why — never a guess.

import { requireSport } from "./sports.js";
import { getScoreboard } from "./espn.js";
import { getBatterGameLog, getPitcherGameLog } from "./mlbData.js";

const STAT_FOR_TREND_TYPE = { hitStreak: "H", rbiStreak: "RBI", power: "HR", pitcherK: "SO" };

function toDatesParam(iso) {
  if (!iso) return null;
  return new Date(iso).toISOString().slice(0, 10).replace(/-/g, "");
}

function baseInfo(leg) {
  return { label: leg.label ?? leg.selection ?? "leg", market: leg.market ?? null, matchup: leg.matchup ?? null };
}

function findGameInLog(log, { eventId, isoDate }) {
  if (eventId) {
    const byId = log.find((g) => g.eventId != null && String(g.eventId) === String(eventId));
    if (byId) return byId;
  }
  if (isoDate) {
    const day = isoDate.slice(0, 10);
    return log.find((g) => (g.date ?? "").slice(0, 10) === day) ?? null;
  }
  return null;
}

function evalOverUnder(actual, side, point) {
  if (actual == null || point == null || !side) return null;
  const s = String(side).toLowerCase();
  if (s === "over") return actual > point;
  if (s === "under") return actual < point;
  return null;
}

async function gradeTrendLeg(leg) {
  const ctx = leg.context ?? {};
  if (!ctx.playerId || !ctx.trendType) {
    return { ...baseInfo(leg), hit: null, note: "No player snapshot captured for this leg (likely an older bet) — can't grade it." };
  }

  let log;
  try {
    log = ctx.trendType === "pitcherK" ? await getPitcherGameLog(ctx.playerId) : await getBatterGameLog(ctx.playerId);
  } catch (err) {
    return { ...baseInfo(leg), hit: null, note: `Couldn't fetch the player's game log: ${err.message}` };
  }

  const game = findGameInLog(log, { eventId: leg.eventId, isoDate: leg.commenceTime });
  if (!game) {
    return { ...baseInfo(leg), hit: null, note: "Couldn't find this game in the player's log yet — it may not be final, or wasn't in the log ESPN returned." };
  }

  const statKey = STAT_FOR_TREND_TYPE[ctx.trendType];
  const actual = game[statKey];
  const hit = evalOverUnder(actual, ctx.propSide, ctx.propPoint);

  const predicted = `Predicted: ${ctx.streakValue ?? "?"}-game streak, ${ctx.matchupLabel ?? "matchup unknown"} (score ${ctx.score ?? "?"}).`;
  const actualText =
    actual != null
      ? `Actual: ${statKey} = ${actual}${ctx.propSide && ctx.propPoint != null ? ` (needed ${ctx.propSide} ${ctx.propPoint})` : ""}.`
      : "Actual stat unavailable.";

  return { ...baseInfo(leg), hit, note: `${predicted} ${actualText}` };
}

async function gradeEdgeLeg(sport, leg) {
  const ctx = leg.context ?? {};
  const datesParam = toDatesParam(leg.commenceTime);
  if (!datesParam || !leg.eventId) {
    return { ...baseInfo(leg), hit: null, note: "No event/date captured for this leg — can't grade it." };
  }

  let scoreboard;
  try {
    scoreboard = await getScoreboard(sport, { datesParam });
  } catch (err) {
    return { ...baseInfo(leg), hit: null, note: `Couldn't reach ESPN for the final score: ${err.message}` };
  }

  const event = scoreboard.find((e) => e.id === leg.eventId);
  if (!event || !event.completed || event.home.score == null || event.away.score == null) {
    return { ...baseInfo(leg), hit: null, note: "Game not final yet." };
  }

  const homeMargin = event.home.score - event.away.score;
  let hit = null;
  if (leg.market === "moneyline") {
    if (homeMargin !== 0) hit = ctx.side === "home" ? homeMargin > 0 : ctx.side === "away" ? homeMargin < 0 : null;
  } else if (leg.market === "spread" && ctx.line != null) {
    const margin = ctx.side === "home" ? homeMargin : -homeMargin;
    const cover = margin + ctx.line;
    if (cover !== 0) hit = cover > 0;
  }

  const predicted = `Predicted: model ${Math.round((ctx.modelProb ?? 0) * 100)}% vs market ${Math.round((ctx.marketProb ?? 0) * 100)}%.`;
  const actualText = `Final: ${event.away.name} ${event.away.score} @ ${event.home.name} ${event.home.score}.`;

  return { ...baseInfo(leg), hit, note: `${predicted} ${actualText}` };
}

/** Analyze every leg of a settled bet against what actually happened. */
export async function analyzeBet(bet) {
  const legs = Array.isArray(bet.legs) && bet.legs.length ? bet.legs : [bet];

  const results = await Promise.all(
    legs.map(async (leg) => {
      const sportKey = leg.sport ?? bet.sport;
      let sport;
      try {
        sport = requireSport(sportKey);
      } catch {
        return { ...baseInfo(leg), hit: null, note: `Unknown sport "${sportKey}" — can't grade it.` };
      }
      const kind = leg.context?.kind ?? (leg.market && STAT_FOR_TREND_TYPE[leg.market] ? "trend" : "edge");
      try {
        return kind === "trend" ? await gradeTrendLeg(leg) : await gradeEdgeLeg(sport, leg);
      } catch (err) {
        return { ...baseInfo(leg), hit: null, note: `Grading failed: ${err.message}` };
      }
    })
  );

  const graded = results.filter((r) => r.hit != null);
  return {
    computedAt: new Date().toISOString(),
    legs: results,
    summary: graded.length
      ? `${graded.filter((r) => r.hit).length}/${graded.length} graded leg(s) correct (${legs.length - graded.length} ungraded)`
      : "Not enough data to grade any leg yet.",
  };
}
