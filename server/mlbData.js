// MLB-specific ESPN data: probable pitchers, rosters, and player game logs.
// This layer is more exploratory than espn.js's scoreboard/schedule/teams
// calls — probable-pitcher and gamelog shapes are less consistently
// documented across ESPN's unofficial API, and this app's sandbox network
// policy blocked verifying them against live responses while building. Every
// function here is defensive: an unexpected shape returns null/[] rather
// than throwing, and callers (trends.js) skip whatever they couldn't get
// instead of failing the whole feed. Treat this file as the first thing to
// check if MLB trends come back thin.

import { cached } from "./cache.js";
import { findStatValue, findStatIndex } from "./statFind.js";

const SITE_BASE = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb";
const WEB_BASE = "https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb";
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

/** Probable starting pitchers for a game, keyed by home/away. Either side may be null ("TBD"). */
export async function getProbablePitchers(espnEventId) {
  return cached(`mlb:probables:${espnEventId}`, 15 * 60 * 1000, async () => {
    try {
      const data = await getJson(`${SITE_BASE}/summary?event=${espnEventId}`);
      const comp = data?.header?.competitions?.[0] ?? data?.competitions?.[0];
      const list = comp?.probables ?? data?.gameInfo?.probables ?? data?.probables;
      if (!Array.isArray(list)) return { home: null, away: null };

      const byHomeAway = (ha) => {
        const entry = list.find((p) => p.homeAway === ha);
        const athlete = entry?.athlete ?? entry?.player;
        if (!athlete?.id) return null;
        return {
          id: String(athlete.id),
          name: athlete.displayName ?? athlete.fullName ?? athlete.shortName ?? "Unknown",
        };
      };
      return { home: byHomeAway("home"), away: byHomeAway("away") };
    } catch {
      return { home: null, away: null };
    }
  });
}

/** Batters on a team's active-ish roster (best-effort: excludes any group ESPN labels as pitchers). */
export async function getTeamBatters(teamId) {
  return cached(`mlb:batters:${teamId}`, 6 * 60 * 60 * 1000, async () => {
    try {
      const data = await getJson(`${SITE_BASE}/teams/${teamId}/roster`);
      const groups = data?.athletes;
      if (!Array.isArray(groups)) return [];
      const batters = [];
      for (const group of groups) {
        const positionLabel = String(group.position ?? "").toLowerCase();
        if (positionLabel.includes("pitcher")) continue;
        for (const a of group.items ?? []) {
          batters.push({ id: String(a.id), name: a.displayName ?? a.fullName });
        }
      }
      return batters;
    } catch {
      return [];
    }
  });
}

function parseGameLog(data, statAliases) {
  // Best-guess shape: data.statistics[] is a list of season-type categories,
  // each with `names` (stat abbreviations) and `events[]` (one per game)
  // whose `stats` array lines up positionally with `names`.
  const categories = data?.statistics ?? data?.seasonTypes?.[0]?.categories ?? [];
  const eventDates = data?.events ?? {}; // eventId -> { gameDate, ... }, best-effort

  for (const category of Array.isArray(categories) ? categories : []) {
    const names = category?.names ?? category?.labels;
    if (!Array.isArray(names)) continue;

    const indices = {};
    for (const [key, aliases] of Object.entries(statAliases)) {
      indices[key] = findStatIndex(names, aliases);
    }
    if (Object.values(indices).every((i) => i === -1)) continue; // wrong category

    const games = (category.events ?? [])
      .map((ev) => {
        const stats = ev.stats ?? [];
        const values = {};
        for (const [key, idx] of Object.entries(indices)) {
          values[key] = idx === -1 ? null : Number(stats[idx]) || 0;
        }
        const dateStr = eventDates[ev.eventId]?.gameDate ?? ev.gameDate ?? ev.date ?? null;
        return { eventId: ev.eventId ?? null, date: dateStr, ...values };
      })
      // Only count games the player actually appeared in, where we can tell.
      .filter((g) => Object.values(g).some((v) => typeof v === "number" && v > 0) || g.appeared);

    games.sort((a, b) => new Date(b.date ?? 0) - new Date(a.date ?? 0));
    return games;
  }
  return [];
}

/** Recent-games-first batting log: [{date, H, HR, RBI}]. */
export async function getBatterGameLog(playerId) {
  return cached(`mlb:batlog:${playerId}`, 60 * 60 * 1000, async () => {
    try {
      const data = await getJson(`${WEB_BASE}/athletes/${playerId}/gamelog`);
      return parseGameLog(data, { H: ["H"], HR: ["HR"], RBI: ["RBI"] });
    } catch {
      return [];
    }
  });
}

/** Recent-starts-first pitching log: [{date, SO, IP}]. */
export async function getPitcherGameLog(playerId) {
  return cached(`mlb:pitchlog:${playerId}`, 60 * 60 * 1000, async () => {
    try {
      const data = await getJson(`${WEB_BASE}/athletes/${playerId}/gamelog`);
      return parseGameLog(data, { SO: ["SO", "K"], IP: ["IP"] });
    } catch {
      return [];
    }
  });
}

/** Season ERA/WHIP/K-per-9 for a starting pitcher, best-effort. */
export async function getPitcherSeasonStats(playerId) {
  return cached(`mlb:pitchstats:${playerId}`, 6 * 60 * 60 * 1000, async () => {
    try {
      const data = await getJson(`${WEB_BASE}/athletes/${playerId}/overview`);
      const stats = data?.statistics ?? data;
      return {
        era: findStatValue(stats, ["ERA"]),
        whip: findStatValue(stats, ["WHIP"]),
        k9: findStatValue(stats, ["K/9", "K9", "SO9"]),
      };
    } catch {
      return { era: null, whip: null, k9: null };
    }
  });
}

/** Team-level batting AVG and strikeout total, for pitcher-K-prop matchup context. */
export async function getTeamBattingContext(teamId) {
  return cached(`mlb:teambat:${teamId}`, 6 * 60 * 60 * 1000, async () => {
    try {
      const data = await getJson(`${SITE_BASE}/teams/${teamId}/statistics`);
      return {
        avg: findStatValue(data, ["AVG"]),
        strikeouts: findStatValue(data, ["SO", "K"]),
      };
    } catch {
      return { avg: null, strikeouts: null };
    }
  });
}
