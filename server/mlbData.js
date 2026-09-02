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

      // Confirmed against a live pregame response: there's no dedicated
      // "probables" field on this endpoint at all (the earlier guess). The
      // starting pitcher is the sole entry in each team's boxscore "pitching"
      // stat category (flagged `starter: true`) — boxscore is populated with
      // the starting lineup before first pitch, not just after. `data.rosters`
      // carries the home/away flag per team id, which boxscore.players itself
      // doesn't, so cross-reference the two.
      const homeAwayByTeamId = {};
      for (const r of data?.rosters ?? []) {
        if (r?.team?.id && r?.homeAway) homeAwayByTeamId[r.team.id] = r.homeAway;
      }

      const result = { home: null, away: null };
      for (const teamBlock of data?.boxscore?.players ?? []) {
        const ha = homeAwayByTeamId[teamBlock?.team?.id];
        if (!ha) continue;
        const pitching = (teamBlock.statistics ?? []).find((c) => String(c.type).toLowerCase().includes("pitch"));
        const starter = pitching?.athletes?.find((a) => a.starter) ?? pitching?.athletes?.[0];
        const athlete = starter?.athlete;
        if (!athlete?.id) continue;
        result[ha] = {
          id: String(athlete.id),
          name: athlete.displayName ?? athlete.fullName ?? athlete.shortName ?? "Unknown",
        };
      }

      if (!result.home && !result.away) {
        warn(
          "getProbablePitchers",
          `event ${espnEventId}: no starter parsed out of boxscore.players. Team ids seen: ${(data?.boxscore?.players ?? []).map((t) => t?.team?.id).join(",")}, rosters homeAway map: ${JSON.stringify(homeAwayByTeamId)}`
        );
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

function parseGameLog(data, statAliases, debugLabel, presenceAliases) {
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
  // A separate "did the player actually appear" index (at-bats for batters,
  // innings pitched for pitchers) — NOT "was any requested stat nonzero".
  // That distinction is the whole fix here: a real 0-for-4 game has H=0 for
  // every requested stat, and needs to stay in the log (to correctly break a
  // hit streak), not get filtered out as if the player didn't play.
  const presenceIdx = presenceAliases ? findStatIndex(sharedNames, presenceAliases) : -1;
  if (presenceAliases && presenceIdx === -1) {
    warn(debugLabel, `presence stat ${JSON.stringify(presenceAliases)} not found in labels/names — falling back to "any requested stat nonzero", which undercounts 0-for-everything games.`);
  }

  // Confirmed against a live response: `categories` isn't one category per
  // season with the "real" one conveniently at index 0 — it's split into
  // several (by month, going by the displayName/splitType seen on a live
  // response, e.g. "august"), and which split lands at index 0 isn't stable
  // across players. Taking only categories[0] silently truncated most
  // players to a few weeks of games, which (combined with different players
  // landing on different splits) is what produced the earlier bug: every
  // batter showing an implausible double-digit hit streak. Merge every
  // category's games instead, deduped by event id, to get the real log.
  const byEvent = new Map();
  for (const category of categories) {
    for (const ev of category.events ?? []) {
      if (!ev?.eventId) continue;
      const stats = ev.stats ?? [];
      const values = {};
      for (const [key, idx] of Object.entries(indices)) {
        values[key] = idx === -1 ? null : Number(stats[idx]) || 0;
      }
      const presence = presenceIdx === -1 ? null : Number(stats[presenceIdx]) || 0;
      const dateStr = eventDates[ev.eventId]?.gameDate ?? ev.gameDate ?? ev.date ?? null;
      byEvent.set(ev.eventId, { eventId: ev.eventId, date: dateStr, presence, ...values });
    }
  }

  const games = [...byEvent.values()]
    .filter((g) =>
      g.presence != null
        ? g.presence > 0
        : Object.entries(g).some(([key, v]) => key !== "eventId" && key !== "date" && typeof v === "number" && v > 0)
    )
    .map(({ presence, ...rest }) => rest);
  if (games.length === 0 && byEvent.size > 0) {
    warn(debugLabel, `merged ${categories.length} categories (${byEvent.size} raw games) but every game was filtered out as "didn't appear" — likely an index problem, not a real 0-for-everything player.`);
  }

  games.sort((a, b) => new Date(b.date ?? 0) - new Date(a.date ?? 0));
  return games;
}

/** Recent-games-first batting log: [{date, H, HR, RBI}]. */
export async function getBatterGameLog(playerId) {
  return cached(`mlb:batlog:${playerId}`, 60 * 60 * 1000, async () => {
    try {
      const data = await getJson(`${WEB_BASE}/athletes/${playerId}/gamelog`);
      // Confirmed live: the top-level `names` array uses full camelCase words
      // ("hits", "homeRuns", "RBIs"); `labels` (confirmed abbreviations —
      // "H"/"HR"/"RBI"/"AB"/...) is preferred when present — both covered here.
      // Presence = at-bats: a real 0-for-4 game (H=0) must stay in the log to
      // correctly break a hit streak, not get dropped as "didn't play".
      return parseGameLog(
        data,
        { H: ["H", "hits"], HR: ["HR", "homeRuns"], RBI: ["RBI", "RBIs"] },
        `getBatterGameLog(${playerId})`,
        ["AB", "atBats"]
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
      // function the same way the batting one just got diagnosed. Presence =
      // innings pitched, so a start with 0 strikeouts stays in the log.
      return parseGameLog(
        data,
        { SO: ["SO", "K", "strikeouts"], IP: ["IP", "inningsPitched"] },
        `getPitcherGameLog(${playerId})`,
        ["IP", "inningsPitched"]
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
