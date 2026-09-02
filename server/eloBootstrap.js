// Builds a live EloEngine for a sport by replaying every completed game of
// the current season, in date order, through the team schedule endpoints.
// Re-running this from scratch each server start keeps it simple (no DB) at
// the cost of ~30 ESPN calls on boot — fine since ESPN has no meaningful
// rate limit for this volume, and results are cached for 6h afterward.

import { EloEngine, BASE_RATING } from "./elo.js";
import { getTeams, getTeamSchedule } from "./espn.js";
import { cached } from "./cache.js";

// 538-style season carryover: seed each team mostly from where they ended
// last season, partially regressed toward the mean, instead of a flat 1500
// for everyone. Without this, ratings early in a season are close to noise
// (which is exactly why edges.js needs MIN_SAMPLE_SIZE as a crutch) — a
// team that finished last season strong should start this one above 1500,
// not at the same point as a team that just finished 30 games under .500.
const CARRYOVER_WEIGHT = 0.75;

/** Replays one specific season's completed games and returns final per-team ratings. */
async function buildFinalRatings(sport, teams, season) {
  const engine = new EloEngine(sport.elo);
  const seen = new Map();
  for (const team of teams) {
    let schedule;
    try {
      schedule = await getTeamSchedule(sport, team.id, season);
    } catch {
      continue;
    }
    for (const ev of schedule) {
      if (ev) seen.set(ev.id, ev);
    }
  }
  const completed = [...seen.values()]
    .filter((ev) => ev.completed && ev.home.score != null && ev.away.score != null)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  for (const ev of completed) {
    engine.applyResult({
      homeTeamId: ev.home.teamId,
      awayTeamId: ev.away.teamId,
      homeScore: ev.home.score,
      awayScore: ev.away.score,
    });
  }
  return engine.ratings; // Map<teamId, rating>
}

async function buildEngine(sport) {
  const teams = await getTeams(sport);
  const engine = new EloEngine(sport.elo);

  // Seed from last season's final ratings before replaying the current one.
  // UNVERIFIED: the `?season=YYYY` query param this relies on (see
  // espn.js's getTeamSchedule) was never confirmed against a live response —
  // this app was built and tested deep into the current MLB season, where
  // carryover barely matters either way. `lastSeasonYear` is also a real
  // guess for any sport whose season spans two calendar years (NBA/NFL) —
  // ESPN's own season-year labeling convention for those wasn't checked. If
  // any of this is wrong, the catch below means it degrades to the exact
  // flat-1500 behavior this app shipped with all day, not corrupted
  // ratings — but it's worth confirming live before trusting April/May
  // edges next season, the same way everything else in mlbData.js needed
  // confirming against real responses before trusting it.
  try {
    const lastSeasonYear = new Date().getFullYear() - 1;
    const finalRatings = await buildFinalRatings(sport, teams, lastSeasonYear);
    for (const team of teams) {
      const prior = finalRatings.get(team.id);
      if (prior != null) {
        engine.ratings.set(team.id, CARRYOVER_WEIGHT * prior + (1 - CARRYOVER_WEIGHT) * BASE_RATING);
      }
    }
  } catch (err) {
    console.warn(`[eloBootstrap] ${sport.key}: season-carryover seeding failed (${err.message}) — falling back to flat ${BASE_RATING} for every team.`);
  }

  const seen = new Map(); // eventId -> event, deduped across both teams' schedules
  for (const team of teams) {
    let schedule;
    try {
      schedule = await getTeamSchedule(sport, team.id);
    } catch {
      continue; // one team's schedule failing shouldn't sink the whole bootstrap
    }
    for (const ev of schedule) {
      if (ev) seen.set(ev.id, ev);
    }
  }

  const completed = [...seen.values()]
    .filter((ev) => ev.completed && ev.home.score != null && ev.away.score != null)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  for (const ev of completed) {
    engine.applyResult({
      homeTeamId: ev.home.teamId,
      awayTeamId: ev.away.teamId,
      homeScore: ev.home.score,
      awayScore: ev.away.score,
    });
  }

  return { engine, teams, gamesApplied: completed.length };
}

export async function getEloEngine(sport) {
  // Cache the whole built engine, not just raw data, so repeated edge-feed
  // requests don't re-replay the season every time.
  return cached(`elo-engine:${sport.key}`, 60 * 60 * 1000, () => buildEngine(sport));
}
