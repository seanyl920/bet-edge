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
import { getProbablePitchers, getTeamBatters, getBatterGameLog, getPitcherGameLog, getTeamBattingContext } from "./mlbData.js";
import { consecutiveStreak, countInLastN, vsTeamSplit } from "./streaks.js";
import { getGameWeather, weatherImpactNote } from "./weather.js";
import { MLB_PARKS } from "./parks.js";
import { getOdds, getPlayerProps } from "./oddsApi.js";
import { matchEspnEvent } from "./teamMatch.js";
import { getCalibration, lookupTrendCalibration } from "./calibration.js";
import { localDateKey } from "./dateUtil.js";
import { cached } from "./cache.js";
import { americanToDecimal, devigMultiplicative } from "./oddsMath.js";

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

function normalizeName(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents (e.g. a name with a combining tilde)
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .trim();
}

/**
 * Whole-word name match, not a raw substring check — a plain
 * `a.includes(b)` would false-match a short name against an unrelated
 * player whose description happens to contain it as a fragment. Requires
 * every word of the shorter name to appear as a complete word in the other.
 */
function namesMatch(a, b) {
  const wordsA = normalizeName(a).split(/\s+/).filter(Boolean);
  const wordsB = normalizeName(b).split(/\s+/).filter(Boolean);
  if (!wordsA.length || !wordsB.length) return false;
  const [shorter, longer] = wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA];
  return shorter.every((w) => longer.includes(w));
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

// Was keyed off team AVG (a low-average lineup treated as a proxy for
// "strikes out a lot") — a real signal for a K prop, but an indirect one: a
// lineup can hit for a low average by making weak contact without actually
// whiffing much. Team strikeout rate (K% = SO / PA) is the direct version of
// the same question, so this now reads that instead. Thresholds are set
// around modern-era MLB's ~22-23% league-average K rate.
function lineupMatchupLabel(teamKRate) {
  if (teamKRate == null) return { label: "unknown", bonus: 0 };
  if (teamKRate >= 0.25) return { label: "favorable matchup — high-strikeout lineup", bonus: 2 };
  if (teamKRate >= 0.21) return { label: "roughly neutral matchup", bonus: 0 };
  return { label: "tough matchup — low-strikeout lineup", bonus: -1 };
}

async function gamesInWindow(sport, hoursAhead) {
  // getScoreboard(sport) with no dates param returns only ESPN's default
  // "today" window (confirmed by every live test this app has seen) — so
  // hoursAhead was silently a no-op past ~24h, never actually reaching
  // tomorrow's slate. Fetch today's and tomorrow's dates explicitly and
  // merge; that covers the full range a 36h-default window can reach
  // without depending on an unverified multi-day `dates=` range syntax
  // (single-day queries are the pattern already confirmed working
  // elsewhere in this app, e.g. postmortem.js's grading). If hoursAhead is
  // ever pushed past ~48h this would need a third day added.
  const todayParam = localDateKey().replace(/-/g, "");
  const tomorrowParam = localDateKey(new Date(Date.now() + 24 * 60 * 60 * 1000)).replace(/-/g, "");
  const [today, tomorrow] = await Promise.all([
    getScoreboard(sport, { datesParam: todayParam }),
    getScoreboard(sport, { datesParam: tomorrowParam }),
  ]);
  const byId = new Map();
  for (const e of [...today, ...tomorrow]) byId.set(e.id, e);

  const now = Date.now();
  const cutoff = now + hoursAhead * 60 * 60 * 1000;
  return [...byId.values()].filter((e) => {
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
  // ERA and WHIP both come from getProbablePitchers now (its `probables`
  // field carries season stats directly — see mlbData.js's Known-issue
  // history note). This used to also call getPitcherSeasonStats (the
  // separate, never-verified /overview endpoint) for WHIP/K9 — dropped: in
  // every live run this app had seen at the time, that call consistently
  // returned nulls. k9 still has no real source. Neither era nor whip is
  // used in scoring, so their absence wouldn't change anything but display.
  const pitcherStats = { era: oppPitcher?.era ?? null, whip: oppPitcher?.whip ?? null, k9: null };
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
  const matchup = lineupMatchupLabel(oppContext.kRate);

  if (kStreak < K_STREAK_MIN && (avgK == null || avgK < K_HOT_AVG_MIN)) return [];

  return [
    {
      eventId: event.id,
      commenceTime: event.date,
      matchup: `${event.away.name} @ ${event.home.name}`,
      type: "pitcherK",
      player: { id: pitcher.id, name: pitcher.name, team: pitcherTeamName },
      opponent: {
        team: oppTeamName,
        teamKRate: oppContext.kRate != null ? `${(oppContext.kRate * 100).toFixed(1)}%` : null,
        teamBattingAvg: oppContext.avg != null ? formatAvg(oppContext.avg) : null,
      },
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

  // A player can have more than one upcoming game inside this window (e.g.
  // a getaway day — home today, away tomorrow against a different
  // opponent). The streak/stat value behind a trend is one snapshot taken
  // right now, not updated per game — so it's shown unchanged for both,
  // even though whichever game happens first will have already moved that
  // number (extended it, or ended it) by the time the later game is
  // played. Showing the same "15 straight games" for both is misleading,
  // not two independent signals — keep only the soonest upcoming game per
  // player+trend-type. Different trend types for the same player/game
  // (e.g. a hit streak and a power trend together) still both show.
  const soonestByPlayerType = new Map();
  for (const t of rawTrends) {
    const key = `${t.player.id}:${t.type}`;
    const existing = soonestByPlayerType.get(key);
    if (!existing || new Date(t.commenceTime) < new Date(existing.commenceTime)) {
      soonestByPlayerType.set(key, t);
    }
  }
  const dedupedTrends = [...soonestByPlayerType.values()];

  const { buckets, minSample } = await getCalibration();
  const trends = dedupedTrends
    .map((t) => {
      // Every trend this app generates and ranks represents the "Over" side
      // (a streak continuing, a K bar cleared — see the comment on this in
      // dailyParlay.js's trendCandidates()), so that's the calibration
      // bucket to rank against — never an Under bucket, which only exists
      // because a user can manually log an Under from the raw odds list.
      const calibration = lookupTrendCalibration(buckets, sport.key, t.type, "over", t.score);
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
 * Mutates `outcomes` in place, adding `.trueProb` to each entry: a devigged
 * probability computed only from Over/Under pairs at that exact same point,
 * averaged across whichever books offer both sides there. An outcome with
 * no matching pair at its own point (e.g. a book posts an Over with no
 * corresponding Under) gets `trueProb: null` — never a number borrowed from
 * a different line.
 */
function attachDevigProbs(outcomes) {
  const byPoint = new Map();
  for (const o of outcomes) {
    const arr = byPoint.get(o.point) ?? [];
    arr.push(o);
    byPoint.set(o.point, arr);
  }
  for (const group of byPoint.values()) {
    const byBook = new Map();
    for (const o of group) {
      o.trueProb = null; // default; only overwritten below when a real pair exists
      if (o.side !== "Over" && o.side !== "Under") continue;
      const entry = byBook.get(o.book) ?? {};
      entry[o.side] = o;
      byBook.set(o.book, entry);
    }
    const overProbs = [];
    const underProbs = [];
    for (const { Over, Under } of byBook.values()) {
      if (!Over || !Under) continue;
      const [pOver, pUnder] = devigMultiplicative([americanToDecimal(Over.price), americanToDecimal(Under.price)]);
      if (pOver != null) {
        overProbs.push(pOver);
        underProbs.push(pUnder);
      }
    }
    if (overProbs.length) {
      const avgOver = overProbs.reduce((s, p) => s + p, 0) / overProbs.length;
      const avgUnder = underProbs.reduce((s, p) => s + p, 0) / underProbs.length;
      for (const o of group) {
        if (o.side === "Over") o.trueProb = avgOver;
        else if (o.side === "Under") o.trueProb = avgUnder;
      }
    }
  }
  return outcomes;
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
  const outcomes = [];
  for (const bm of propEvent?.bookmakers ?? []) {
    const market = bm.markets?.find((m) => m.key === marketKey);
    if (!market) continue;
    for (const o of market.outcomes ?? []) {
      const desc = o.description ?? o.name ?? "";
      if (namesMatch(playerName, desc)) {
        outcomes.push({ book: bm.title, side: o.name, point: o.point ?? null, price: o.price });
      }
    }
  }
  // Confirmed real bug: a caller (dailyParlay.js) was picking the
  // highest-paying Over across every point mixed together, then pricing it
  // against a probability averaged across every point too — a leg priced
  // at, say, Over 1.5 could get assigned a probability that's really an
  // average of the Over 1.5 AND Over 0.5 markets, which are different bets.
  // Compute a devigged probability per exact point instead, and attach it
  // to every outcome at that point, so any caller reading `.trueProb` off
  // a specific outcome always gets the number that actually corresponds to
  // that specific line — never mixed across points.
  attachDevigProbs(outcomes);
  return { available: true, outcomes };
}
