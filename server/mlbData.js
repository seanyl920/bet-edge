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

// These functions used to fail silently (return [] / null) on any problem —
// safe for the app, useless for debugging. This logs *why* every time
// something comes back empty, so a thin trend feed is diagnosable from the
// terminal instead of a guess. Prefix "[mlbData]" so it's easy to grep for.
function warn(fn, detail) {
  console.warn(`[mlbData] ${fn}: ${detail}`);
}

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
      if (!Array.isArray(list)) {
        warn(
          "getProbablePitchers",
          `event ${espnEventId}: no probables array found (checked comp.probables, gameInfo.probables, data.probables). ` +
            `Top-level keys: ${Object.keys(data ?? {}).join(", ")}`
        );
        return { home: null, away: null };
      }

      const byHomeAway = (ha) => {
        const entry = list.find((p) => p.homeAway === ha);
        const athlete = entry?.athlete ?? entry?.player;
        if (!athlete?.id) return null;
        return {
          id: String(athlete.id),
          name: athlete.displayName ?? athlete.fullName ?? athlete.shortName ?? "Unknown",
        };
      };
      const result = { home: byHomeAway("home"), away: byHomeAway("away") };
      if (!result.home && !result.away) {
        warn("getProbablePitchers", `event ${espnEventId}: probables array present (len ${list.length}) but neither home nor away athlete parsed out of it. Sample entry: ${JSON.stringify(list[0])}`);
      }
      return result;
    } catch (err) {
      warn("getProbablePitchers", `event ${espnEventId}: request failed — ${err.message}`);
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
      if (!Array.isArray(groups)) {
        warn("getTeamBatters", `team ${teamId}: data.athletes isn't an array. Top-level keys: ${Object.keys(data ?? {}).join(", ")}`);
        return [];
      }
      const batters = [];
      for (const group of groups) {
        const positionLabel = String(group.position ?? "").toLowerCase();
        if (positionLabel.includes("pitcher")) continue;
        for (const a of group.items ?? []) {
          batters.push({ id: String(a.id), name: a.displayName ?? a.fullName });
        }
      }
      if (batters.length === 0) {
        warn("getTeamBatters", `team ${teamId}: 0 batters parsed from ${groups.length} group(s). Group labels: ${groups.map((g) => g.position).join(", ")}`);
      }
      return batters;
    } catch (err) {
      warn("getTeamBatters", `team ${teamId}: request failed — ${err.message}`);
      return [];
    }
  });
}

function parseGameLog(data, statAliases, debugLabel) {
  // Real shape (confirmed against a live response — see git history for the
  // earlier best-guess this replaced): `labels`/`names` are shared arrays at
  // the TOP LEVEL of the whole gamelog response, not per-category. Each
  // category (data.seasonTypes[0].categories[i], one per season/split) has
  // `events[]` (one per game) whose `stats` array lines up positionally
  // against that shared top-level array — not its own.
  const categories = data?.statistics ?? data?.seasonTypes?.[0]?.categories ?? [];
  const eventDates = data?.events ?? {}; // eventId -> { gameDate, ... }, best-effort
  const sharedNames = data?.labels ?? data?.names;

  if (!Array.isArray(categories) || categories.length === 0) {
    warn(debugLabel, `no statistics categories found. Top-level keys: ${Object.keys(data ?? {}).join(", ")}`);
    return [];
  }
  if (!Array.isArray(sharedNames)) {
    warn(debugLabel, `no top-level labels/names array to index stats by. Top-level keys: ${Object.keys(data ?? {}).join(", ")}`);
    return [];
  }

  const indices = {};
  for (const [key, aliases] of Object.entries(statAliases)) {
    indices[key] = findStatIndex(sharedNames, aliases);
  }
  if (Object.values(indices).every((i) => i === -1)) {
    warn(debugLabel, `none of ${JSON.stringify(Object.values(statAliases).flat())} matched the labels/names array: ${JSON.stringify(sharedNames)}`);
    return [];
  }

  // First category observed to be the full/overall log across every player
  // checked while diagnosing this — later ones look like splits (vs LHP,
  // home/away, etc.) based on varying category counts per player.
  const category = categories[0];
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

/** Recent-games-first batting log: [{date, H, HR, RBI}]. */
export async function getBatterGameLog(playerId) {
  return cached(`mlb:batlog:${playerId}`, 60 * 60 * 1000, async () => {
    try {
      const data = await getJson(`${WEB_BASE}/athletes/${playerId}/gamelog`);
      // Confirmed live: the top-level `names` array uses full camelCase words
      // ("hits", "homeRuns", "RBIs"); `labels` (probably abbreviations like
      // "H"/"HR"/"RBI") is preferred when present — both are covered here.
      return parseGameLog(
        data,
        { H: ["H", "hits"], HR: ["HR", "homeRuns"], RBI: ["RBI", "RBIs"] },
        `getBatterGameLog(${playerId})`
      );
    } catch (err) {
      warn("getBatterGameLog", `player ${playerId}: request failed — ${err.message}`);
      return [];
    }
  });
}

/** Recent-starts-first pitching log: [{date, SO, IP}]. */
export async function getPitcherGameLog(playerId) {
  return cached(`mlb:pitchlog:${playerId}`, 60 * 60 * 1000, async () => {
    try {
      const data = await getJson(`${WEB_BASE}/athletes/${playerId}/gamelog`);
      // Pitching gamelogs weren't directly confirmed (only batting was) — these
      // aliases are the same kind of guess as before, just with more variants.
      // If pitcher trends stay empty, check the [mlbData] warn output for this
      // function the same way the batting one just got diagnosed.
      return parseGameLog(
        data,
        { SO: ["SO", "K", "strikeouts"], IP: ["IP", "inningsPitched"] },
        `getPitcherGameLog(${playerId})`
      );
    } catch (err) {
      warn("getPitcherGameLog", `player ${playerId}: request failed — ${err.message}`);
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
    } catch (err) {
      warn("getPitcherSeasonStats", `player ${playerId}: request failed — ${err.message}`);
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
    } catch (err) {
      warn("getTeamBattingContext", `team ${teamId}: request failed — ${err.message}`);
      return { avg: null, strikeouts: null };
    }
  });
}
