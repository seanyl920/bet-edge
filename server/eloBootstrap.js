// Builds a live EloEngine for a sport by replaying every completed game of
// the current season, in date order, through the team schedule endpoints.
// Re-running this from scratch each server start keeps it simple (no DB) at
// the cost of ~30 ESPN calls on boot — fine since ESPN has no meaningful
// rate limit for this volume, and results are cached for 6h afterward.

import { EloEngine } from "./elo.js";
import { getTeams, getTeamSchedule } from "./espn.js";
import { cached } from "./cache.js";

async function buildEngine(sport) {
  const teams = await getTeams(sport);
  const engine = new EloEngine(sport.elo);

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
