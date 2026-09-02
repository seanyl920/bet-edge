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
import { localDateKey } from "./dateUtil.js";

// vsTeamHistory was missing here — a real bug, confirmed live: a batter's
// "vs this team" trend is a hits-based signal (see trends.js's vsTeamSplit/
// vsTeamContext), so it needs "H" the same as hitStreak, but with no entry
// at all `game[undefined]` was always `undefined`, meaning every
// vsTeamHistory bet came back "Actual stat unavailable" regardless of what
// actually happened.
const STAT_FOR_TREND_TYPE = { hitStreak: "H", rbiStreak: "RBI", power: "HR", pitcherK: "SO", vsTeamHistory: "H" };

// Local day, not UTC — an evening game's commence time is often past
// midnight UTC, which used to permanently return "not final yet" for it
// (querying ESPN for the wrong calendar day, forever, on every re-analyze —
// see README's Known-issue history).
function toDatesParam(iso) {
  const key = localDateKey(iso);
  return key ? key.replace(/-/g, "") : null;
}

function baseInfo(leg) {
  return { label: leg.label ?? leg.selection ?? "leg", market: leg.market ?? null, matchup: leg.matchup ?? null };
}

function findGameInLog(log, { eventId, isoDate }) {
  if (eventId) {
    // Confirmed real bug: this used to fall through to the isoDate fallback
    // below whenever eventId didn't match anything — but having an eventId
    // at all means we KNOW which specific game this leg is about; if it's
    // not in the log, that's a real gap (ESPN hasn't posted it yet, or
    // something's off), not a reason to guess. Falling back to "any game
    // this player had that same calendar day" is exactly wrong on a
    // doubleheader day — it can silently grade the leg off the wrong game.
    // Only fall back to date-matching when there's no eventId to check at
    // all (an older bet that never captured one).
    return log.find((g) => g.eventId != null && String(g.eventId) === String(eventId)) ?? null;
  }
  if (isoDate) {
    // Both sides converted to the same local day — g.date is also a UTC
    // ISO timestamp from ESPN, so comparing raw UTC slices has the same
    // wrong-day risk toDatesParam above was just fixed for.
    const day = localDateKey(isoDate);
    return log.find((g) => localDateKey(g.date) === day) ?? null;
  }
  return null;
}

// A whole-number point (e.g. "Over 6" rather than the usual "Over 6.5") can
// land exactly on the actual stat — a real push, not a loss. Checked
// separately from evalOverUnder below (not folded into it) because `hit`
// stays strictly true/false/null everywhere downstream (calibration.js and
// analyzeBet() both do truthy/`!= null` checks on it) — a push has to come
// out as null (not counted either way), never as some third truthy value
// that would silently get counted as a win.
function isPush(actual, point) {
  return actual != null && point != null && actual === point;
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
  const push = isPush(actual, ctx.propPoint);
  const hit = push ? null : evalOverUnder(actual, ctx.propSide, ctx.propPoint);

  const predicted = `Predicted: ${ctx.streakValue ?? "?"}-game streak, ${ctx.matchupLabel ?? "matchup unknown"} (score ${ctx.score ?? "?"}).`;
  const actualText =
    actual != null
      ? `Actual: ${statKey} = ${actual}${ctx.propSide && ctx.propPoint != null ? ` (needed ${ctx.propSide} ${ctx.propPoint})` : ""}${push ? " — push, landed exactly on the line, not counted." : ""}.`
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
