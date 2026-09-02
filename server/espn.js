// ESPN's public "site" API. It's unofficial and undocumented, but it's the
// same free, keyless, CORS-friendly data source a lot of hobby sports-stats
// projects rely on for scores, schedules, and team info. We only read from
// it and treat every field defensively — ESPN can and does change shapes
// without notice.

import { cached } from "./cache.js";

const BASE = "https://site.api.espn.com/apis/site/v2/sports";
const FETCH_TIMEOUT_MS = 8000;

async function getJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`ESPN ${res.status} ${res.statusText} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function leaguePath(sport) {
  return `${BASE}/${sport.espnSport}/${sport.espnLeague}`;
}

/** All teams for a league: [{ id, name, abbreviation, location }] */
export async function getTeams(sport) {
  return cached(`espn:teams:${sport.key}`, 6 * 60 * 60 * 1000, async () => {
    const data = await getJson(`${leaguePath(sport)}/teams?limit=100`);
    const list = data?.sports?.[0]?.leagues?.[0]?.teams ?? [];
    return list.map((entry) => {
      const t = entry.team;
      return {
        id: String(t.id),
        name: t.displayName,
        shortName: t.shortDisplayName,
        abbreviation: t.abbreviation,
        location: t.location,
        logo: t.logos?.[0]?.href ?? null,
      };
    });
  });
}

/** Upcoming + recent scoreboard events. */
export async function getScoreboard(sport, { datesParam } = {}) {
  const qs = datesParam ? `?dates=${datesParam}&limit=1000` : "?limit=1000";
  const key = `espn:scoreboard:${sport.key}:${datesParam ?? "current"}`;
  return cached(key, 5 * 60 * 1000, async () => {
    const data = await getJson(`${leaguePath(sport)}/scoreboard${qs}`);
    return (data?.events ?? []).map(normalizeEvent);
  });
}

/** Full schedule (played + upcoming) for one team, used to bootstrap Elo. */
export async function getTeamSchedule(sport, teamId, season) {
  const key = `espn:schedule:${sport.key}:${teamId}:${season ?? "current"}`;
  return cached(key, 6 * 60 * 60 * 1000, async () => {
    const seasonQs = season ? `?season=${season}` : "";
    const data = await getJson(`${leaguePath(sport)}/teams/${teamId}/schedule${seasonQs}`);
    return (data?.events ?? []).map(normalizeEvent).filter(Boolean);
  });
}

/** Best-effort injury report for a team. ESPN doesn't guarantee this shape or endpoint uptime. */
export async function getTeamInjuries(sport, teamId) {
  const key = `espn:injuries:${sport.key}:${teamId}`;
  return cached(key, 30 * 60 * 1000, async () => {
    try {
      const data = await getJson(`${leaguePath(sport)}/teams/${teamId}/injuries`);
      const list = data?.injuries ?? data?.items ?? [];
      return list.map((i) => ({
        player: i.athlete?.displayName ?? i.displayName ?? "Unknown",
        status: i.status ?? i.type?.description ?? "Unknown",
        detail: i.details?.type ?? i.longComment ?? i.shortComment ?? null,
      }));
    } catch {
      return null; // "unavailable", not "no injuries"
    }
  });
}

// Confirmed live (Sept 2026): a competitor's `score` on this endpoint is an
// object — `{ value: 4, displayValue: "4" }` — not a bare number. The old
// `Number(home.score)` coerced that whole object (via its default
// toString(), "[object Object]") to NaN every single time, for every
// completed game, on every sport — this is the root cause the Elo
// NaN-contamination fix (see elo.js) actually traced back to: no completed
// game was ever being correctly folded into a rating. Handles a bare
// number too, just in case the shape ever differs by endpoint or context.
function extractScore(raw) {
  if (raw == null) return null;
  const n = Number(typeof raw === "object" ? raw.value : raw);
  return Number.isFinite(n) ? n : null;
}

function normalizeEvent(ev) {
  const comp = ev?.competitions?.[0];
  if (!comp) return null;
  const home = comp.competitors?.find((c) => c.homeAway === "home");
  const away = comp.competitors?.find((c) => c.homeAway === "away");
  if (!home || !away) return null;
  const status = ev.status?.type?.name ?? comp.status?.type?.name ?? "";
  return {
    id: String(ev.id),
    date: ev.date,
    name: ev.name ?? ev.shortName,
    shortName: ev.shortName,
    completed: Boolean(ev.status?.type?.completed ?? comp.status?.type?.completed),
    statusName: status, // e.g. STATUS_SCHEDULED, STATUS_FINAL, STATUS_IN_PROGRESS
    venue: comp.venue
      ? {
          name: comp.venue.fullName,
          indoor: Boolean(comp.venue.indoor),
          city: comp.venue.address?.city ?? null,
          state: comp.venue.address?.state ?? null,
        }
      : null,
    home: {
      teamId: String(home.team?.id),
      name: home.team?.displayName,
      abbreviation: home.team?.abbreviation,
      score: extractScore(home.score),
    },
    away: {
      teamId: String(away.team?.id),
      name: away.team?.displayName,
      abbreviation: away.team?.abbreviation,
      score: extractScore(away.score),
    },
  };
}
