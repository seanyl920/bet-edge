// The trend engine: for each of today's/tomorrow's MLB games, scan both
// teams' batters for hot streaks (hits, power, RBI) and both probable
// starters for strikeout streaks, attach the situational context that makes
// a streak worth caring about (opposing pitcher quality, opposing lineup's
// contact ability, ballpark/weather), and rank everything with a
// transparent, additive heuristic score.
//
// That score is explicitly NOT a win probability or a devigged EV number —
// unlike edges.js, there's no market price backing these out. It's a
// "how many real supporting factors stacked up" count, shown as such, so you
// can apply your own judgment on top rather than trusting a black box.
//
// Once your bet log has enough graded history in a given (trend type, score)
// bucket — see calibration.js — this ranks by that bucket's real hit rate
// instead of the heuristic score, and says so on every trend so it's never a
// silent change (`rankedBy: "calibration"` vs `"heuristic"`).

import { getScoreboard } from "./espn.js";
import { getProbablePitchers, getTeamBatters, getBatterGameLog, getPitcherGameLog, getPitcherSeasonStats, getTeamBattingContext } from "./mlbData.js";
import { consecutiveStreak, countInLastN, vsTeamSplit } from "./streaks.js";
import { getGameWeather, weatherImpactNote } from "./weather.js";
import { MLB_PARKS } from "./parks.js";
import { getOdds, getPlayerProps } from "./oddsApi.js";
import { matchEspnEvent } from "./teamMatch.js";
import { getCalibration, lookupTrendCalibration } from "./calibration.js";
import { cached } from "./cache.js";

const HIT_STREAK_MIN = 5;
const RBI_STREAK_MIN = 3;
const HR_STREAK_MIN = 2;
const HR_HOT_IN_10_MIN = 3;
const K_STREAK_MIN = 3;
const K_HOT_AVG_MIN = 7;

const PROP_MARKET = {
  hitStreak: "batter_hits",
  power: "batter_home_runs",
  rbiStreak: "batter_rbis",
  pitcherK: "pitcher_strikeouts",
  vsTeamHistory: "batter_hits",
};

// "Vs this team" history — this-season-only (see streaks.js's vsTeamSplit),
// so the bar is deliberately not tiny: 15 AB is still a small sample by any
// serious statistical standard, but it's enough that it's not just 3 lucky
// swings, and it's honestly labeled either way (see formatVsTeam below).
const VS_TEAM_MIN_AB = 15;
const VS_TEAM_HOT_AVG = 0.3;
const VS_TEAM_VERY_HOT_AVG = 0.35;

function formatAvg(avg) {
  return avg == null ? "—" : avg.toFixed(3).replace(/^0/, "");
}

function vsTeamContext(split, oppTeamName) {
  if (split.AB < VS_TEAM_MIN_AB || split.avg == null) return { bonus: 0, note: null };
  if (split.avg >= VS_TEAM_VERY_HOT_AVG) {
    return { bonus: 2, note: `hitting ${formatAvg(split.avg)} vs ${oppTeamName} this season (${split.H}-for-${split.AB}, ${split.games}g)` };
  }
  if (split.avg >= VS_TEAM_HOT_AVG) {
    return { bonus: 1, note: `hitting ${formatAvg(split.avg)} vs ${oppTeamName} this season (${split.H}-for-${split.AB}, ${split.games}g)` };
  }
  return { bonus: 0, note: null };
}

function pitcherMatchupLabel(era) {
  if (era == null) return { label: "unknown", bonus: 0 };
  if (era >= 5.0) return { label: "very favorable matchup — ERA over 5.00", bonus: 2 };
  if (era >= 4.3) return { label: "favorable matchup — below-average ERA", bonus: 1 };
  if (era >= 3.5) return { label: "roughly neutral matchup", bonus: 0 };
  return { label: "tough matchup — sharp starter", bonus: -1 };
}

function lineupMatchupLabel(teamAvg) {
  if (teamAvg == null) return { label: "unknown", bonus: 0 };
  if (teamAvg <= 0.235) return { label: "favorable matchup — low-contact lineup", bonus: 2 };
  if (teamAvg <= 0.255) return { label: "roughly neutral matchup", bonus: 0 };
  return { label: "tough matchup — high-contact lineup", bonus: -1 };
}

async function gamesInWindow(sport, hoursAhead) {
  const scoreboard = await getScoreboard(sport);
  const now = Date.now();
  const cutoff = now + hoursAhead * 60 * 60 * 1000;
  return scoreboard.filter((e) => {
    if (e.statusName !== "STATUS_SCHEDULED") return false;
    const t = new Date(e.date).getTime();
    return t >= now - 30 * 60 * 1000 && t <= cutoff; // small grace window for games just starting
  });
}

async function getParkWeather(sport, homeAbbreviation, isoDate) {
  const venue = MLB_PARKS[homeAbbreviation];
  if (!venue || venue.roof !== "open") return { park: venue ?? null, weather: null };
  try {
    const w = await getGameWeather(venue.lat, venue.lon, isoDate);
    return {
      park: venue,
      weather: w ? { ...w, note: weatherImpactNote(w, "mlb") } : null,
    };
  } catch {
    return { park: venue, weather: null };
  }
}

async function battingTrendsForTeam({ event, batterTeamId, batterTeamName, oppTeamId, oppTeamName, oppPitcher, park, weather }) {
  const batters = await getTeamBatters(batterTeamId);
  // ERA from getProbablePitchers (pulled straight from a confirmed-working
  // pregame boxscore) is preferred over the separate /overview endpoint
  // below, whose response shape was never directly verified — WHIP/K9 still
  // come from it, best-effort, for display only (not used in scoring).
  const seasonStats = oppPitcher ? await getPitcherSeasonStats(oppPitcher.id) : { era: null, whip: null, k9: null };
  const pitcherStats = { ...seasonStats, era: oppPitcher?.era ?? seasonStats.era };
  const matchup = pitcherMatchupLabel(pitcherStats.era);

  const trends = [];
  await Promise.all(
    batters.map(async (batter) => {
      const log = await getBatterGameLog(batter.id);
      if (!log.length) return;

      const hitStreak = consecutiveStreak(log, (g) => g.H >= 1);
      const rbiStreak = consecutiveStreak(log, (g) => g.RBI >= 1);
      const hrStreak = consecutiveStreak(log, (g) => g.HR >= 1);
      const hrIn10 = countInLastN(log, 10, (g) => g.HR >= 1);

      const split = vsTeamSplit(log, oppTeamId);
      const vsTeam = vsTeamContext(split, oppTeamName);

      const base = {
        eventId: event.id,
        commenceTime: event.date,
        matchup: `${event.away.name} @ ${event.home.name}`,
        player: { id: batter.id, name: batter.name, team: batterTeamName },
        opponent: { team: oppTeamName, pitcher: oppPitcher },
        pitcherStats,
        matchupLabel: matchup.label,
        vsTeamNote: vsTeam.note,
        park: park ? { name: park.name, note: park.note ?? null } : null,
        weather,
      };

      const batterTrends = [];
      if (hitStreak >= HIT_STREAK_MIN) {
        batterTrends.push({
          ...base,
          type: "hitStreak",
          headline: `${batter.name} has a hit in ${hitStreak} straight games`,
          streakValue: hitStreak,
          score: Math.min(hitStreak, 12) + matchup.bonus + vsTeam.bonus,
        });
      }
      if (rbiStreak >= RBI_STREAK_MIN) {
        batterTrends.push({
          ...base,
          type: "rbiStreak",
          headline: `${batter.name} has an RBI in ${rbiStreak} straight games`,
          streakValue: rbiStreak,
          score: Math.min(rbiStreak, 10) + matchup.bonus + vsTeam.bonus,
        });
      }
      if (hrStreak >= HR_STREAK_MIN || hrIn10 >= HR_HOT_IN_10_MIN) {
        batterTrends.push({
          ...base,
          type: "power",
          headline:
            hrStreak >= HR_STREAK_MIN
              ? `${batter.name} has homered in ${hrStreak} straight games`
              : `${batter.name} has ${hrIn10} HR in his last 10 games`,
          streakValue: hrStreak >= HR_STREAK_MIN ? hrStreak : hrIn10,
          score: (hrStreak >= HR_STREAK_MIN ? hrStreak * 3 : hrIn10 * 2) + matchup.bonus + vsTeam.bonus,
        });
      }

      // A batter with no current streak can still be worth a look on
      // "vs this team" history alone — surface it standalone rather than
      // only ever as a bonus riding along on some other trend.
      if (batterTrends.length === 0 && vsTeam.note) {
        batterTrends.push({
          ...base,
          type: "vsTeamHistory",
          headline: `${batter.name} is ${vsTeam.note}`,
          streakValue: split.games,
          score: Math.round(split.avg * 20) + Math.min(Math.floor(split.AB / 10), 3) + matchup.bonus,
        });
      }

      trends.push(...batterTrends);
    })
  );
  return trends;
}

async function pitcherKTrends({ event, pitcher, pitcherTeamName, oppTeamId, oppTeamName, park, weather }) {
  if (!pitcher) return [];
  const [log, oppContext] = await Promise.all([
    getPitcherGameLog(pitcher.id),
    getTeamBattingContext(oppTeamId),
  ]);
  if (!log.length) return [];

  const kStreak = consecutiveStreak(log, (g) => g.SO >= 6);
  const last5 = log.slice(0, 5);
  const avgK = last5.length ? last5.reduce((s, g) => s + (g.SO ?? 0), 0) / last5.length : null;
  const matchup = lineupMatchupLabel(oppContext.avg);

  if (kStreak < K_STREAK_MIN && (avgK == null || avgK < K_HOT_AVG_MIN)) return [];

  return [
    {
      eventId: event.id,
      commenceTime: event.date,
      matchup: `${event.away.name} @ ${event.home.name}`,
      type: "pitcherK",
      player: { id: pitcher.id, name: pitcher.name, team: pitcherTeamName },
      opponent: { team: oppTeamName, teamBattingAvg: oppContext.avg },
      matchupLabel: matchup.label,
      park: park ? { name: park.name, note: park.note ?? null } : null,
      weather,
      headline:
        kStreak >= K_STREAK_MIN
          ? `${pitcher.name} has 6+ strikeouts in ${kStreak} straight starts`
          : `${pitcher.name} is averaging ${avgK.toFixed(1)} K over his last ${last5.length} starts`,
      streakValue: kStreak >= K_STREAK_MIN ? kStreak : Math.round(avgK),
      score: (kStreak >= K_STREAK_MIN ? kStreak * 2 : Math.round(avgK)) + matchup.bonus,
    },
  ];
}

async function buildTrends(sport, hoursAhead) {
  const games = await gamesInWindow(sport, hoursAhead);

  const perGame = await Promise.all(
    games.map(async (event) => {
      const probables = await getProbablePitchers(event.id);
      const { park, weather } = await getParkWeather(sport, event.home.abbreviation, event.date);

      const [homeBatting, awayBatting, homeK, awayK] = await Promise.all([
        battingTrendsForTeam({
          event,
          batterTeamId: event.home.teamId,
          batterTeamName: event.home.name,
          oppTeamId: event.away.teamId,
          oppTeamName: event.away.name,
          oppPitcher: probables.away,
          park,
          weather,
        }),
        battingTrendsForTeam({
          event,
          batterTeamId: event.away.teamId,
          batterTeamName: event.away.name,
          oppTeamId: event.home.teamId,
          oppTeamName: event.home.name,
          oppPitcher: probables.home,
          park,
          weather,
        }),
        pitcherKTrends({
          event,
          pitcher: probables.home,
          pitcherTeamName: event.home.name,
          oppTeamId: event.away.teamId,
          oppTeamName: event.away.name,
          park,
          weather,
        }),
        pitcherKTrends({
          event,
          pitcher: probables.away,
          pitcherTeamName: event.away.name,
          oppTeamId: event.home.teamId,
          oppTeamName: event.home.name,
          park,
          weather,
        }),
      ]);

      return [...homeBatting, ...awayBatting, ...homeK, ...awayK];
    })
  );

  const rawTrends = perGame.flat();

  const { buckets, minSample } = await getCalibration();
  const trends = rawTrends
    .map((t) => {
      const calibration = lookupTrendCalibration(buckets, sport.key, t.type, t.score);
      return {
        ...t,
        calibration, // {rate, n} once a bucket has enough graded history, else null
        rankedBy: calibration ? "calibration" : "heuristic",
        rank: calibration ? calibration.rate * 20 : t.score,
      };
    })
    .sort((a, b) => b.rank - a.rank);

  return {
    trends,
    gamesScanned: games.length,
    calibrationMinSample: minSample,
    thresholds: {
      hitStreak: HIT_STREAK_MIN,
      rbiStreak: RBI_STREAK_MIN,
      hrStreak: HR_STREAK_MIN,
      hrIn10: HR_HOT_IN_10_MIN,
      kStreak: K_STREAK_MIN,
      kHotAvg: K_HOT_AVG_MIN,
    },
  };
}

export async function getTrendFeed(sport, { hoursAhead = 36 } = {}) {
  // The bootstrap above is a lot of ESPN calls (probables + rosters +
  // per-batter gamelogs for every scheduled game in the window) — cache the
  // assembled result, don't rebuild it on every page load.
  return cached(`mlb-trends:${sport.key}:${hoursAhead}`, 15 * 60 * 1000, () => buildTrends(sport, hoursAhead));
}

/**
 * On-demand player-prop odds for one trend. Only call this from an explicit
 * user action ("check odds") — never automatically — since player props are
 * a separate, credit-costing call on The Odds API per event.
 */
export async function getTrendPropOdds(sport, espnEventId, playerName, trendType) {
  const marketKey = PROP_MARKET[trendType];
  if (!marketKey) {
    const err = new Error(`No prop market mapped for trend type "${trendType}"`);
    err.status = 400;
    throw err;
  }

  const [{ events: oddsEvents }, scoreboard] = await Promise.all([
    getOdds(sport, { markets: "h2h" }), // cheapest bulk call, just to locate the event id
    getScoreboard(sport),
  ]);
  const oddsEvent = oddsEvents.find((e) => matchEspnEvent(e, scoreboard)?.id === espnEventId);
  if (!oddsEvent) return { available: false, outcomes: [] };

  const { event: propEvent } = await getPlayerProps(sport, oddsEvent.id, marketKey);
  const nameLower = playerName.toLowerCase();
  const outcomes = [];
  for (const bm of propEvent?.bookmakers ?? []) {
    const market = bm.markets?.find((m) => m.key === marketKey);
    if (!market) continue;
    for (const o of market.outcomes ?? []) {
      const desc = (o.description ?? o.name ?? "").toLowerCase();
      if (desc.includes(nameLower) || nameLower.includes(desc)) {
        outcomes.push({ book: bm.title, side: o.name, point: o.point ?? null, price: o.price });
      }
    }
  }
  return { available: true, outcomes };
}
