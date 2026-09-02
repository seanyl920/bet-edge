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

// Shared by getProbablePitchers and getConfirmedLineup — both read
// different parts of the same `summary?event=` response, so this fetches
// and caches it once instead of hitting ESPN twice for the same game.
function getEventSummary(espnEventId) {
  return cached(`mlb:summary:${espnEventId}`, 15 * 60 * 1000, () => getJson(`${SITE_BASE}/summary?event=${espnEventId}`));
}

/** Probable starting pitchers for a game, keyed by home/away. Either side may be null ("TBD"). */
export async function getProbablePitchers(espnEventId) {
  return cached(`mlb:probables:${espnEventId}`, 15 * 60 * 1000, async () => {
    try {
      const data = await getEventSummary(espnEventId);

      // Was: read the starter out of the pregame boxscore's "pitching" stat
      // category (`starter: true` flag), cross-referenced against
      // `data.rosters` for the home/away flag. That broke — live checks in
      // September 2026 showed every team's boxscore categories present but
      // with 0 athletes, for games still hours from first pitch (lineups
      // evidently post later than they used to, or ESPN stopped populating
      // this pregame). Re-diagnosed live: there's now a dedicated
      // `header.competitions[0].competitors[*].probables[0]` field, which
      // *is* populated this early, and it carries `homeAway` directly (no
      // more cross-referencing `data.rosters`) plus the starter's season
      // ERA *and* WHIP right there in `statistics.splits.categories` — an
      // upgrade over the old source, which never had WHIP at all (see
      // README's Known-issue history for the pitcher-stats endpoint this
      // replaces the dropped call to).
      const competitors = data?.header?.competitions?.[0]?.competitors ?? [];
      const result = { home: null, away: null };
      for (const c of competitors) {
        const ha = c?.homeAway;
        if (ha !== "home" && ha !== "away") continue;
        const probable = c?.probables?.[0];
        const athlete = probable?.athlete;
        if (!athlete?.id) continue;
        const categories = probable?.statistics?.splits?.categories ?? [];
        const statValue = (name) => {
          const v = categories.find((cc) => String(cc.name).toUpperCase() === name)?.value;
          return Number.isFinite(v) ? v : null;
        };
        result[ha] = {
          id: String(athlete.id),
          name: athlete.displayName ?? athlete.fullName ?? athlete.shortName ?? "Unknown",
          era: statValue("ERA"),
          whip: statValue("WHIP"),
        };
      }

      if (!result.home && !result.away) {
        warn(
          "getProbablePitchers",
          `event ${espnEventId}: no probables found. Competitor homeAway values seen: ${competitors.map((c) => c?.homeAway).join(",")}`
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

/**
 * The CONFIRMED starting lineup for a game, keyed by home/away — never the
 * full roster. Confirmed live against two games a few hours apart (Sept
 * 2026): `summary?event=`'s `boxscore.players[team].statistics[]` carries a
 * batting category whose `athletes[]` array is populated with real
 * `{starter: true, batOrder: 1-9}` entries once the lineup posts, and is an
 * EMPTY array — never a partial or placeholder one — for a game whose
 * lineup hasn't posted yet. That emptiness is the confirmation signal:
 * `confirmed: false` with `batters: []` means exactly "not posted yet,"
 * never "this team has no batters." Callers must never fall back to
 * getTeamBatters()'s full roster and treat it as if it were this — that's
 * exactly the "confirmed vs. projected" conflation this function exists to
 * prevent. There is no explicit "official" flag in ESPN's response (no key
 * scan for one turned up anything); array-populated-or-not is the only
 * signal available, so that's what this relies on.
 *
 * Also returns `startingPitcherRole` per side — the confirmed starter's
 * boxscore position ("SP" vs. "RP"), a real signal for an opener/bulk-
 * reliever role, from the same response at the same confirmation moment.
 */
export async function getConfirmedLineup(espnEventId) {
  try {
    const data = await getEventSummary(espnEventId);

    // boxscore.players[] entries don't carry `homeAway` directly, only a
    // team id — cross-reference against header.competitions[0].competitors,
    // the same reliable home/away source getProbablePitchers uses.
    const competitors = data?.header?.competitions?.[0]?.competitors ?? [];
    const teamIdToHomeAway = new Map();
    for (const c of competitors) {
      if ((c?.homeAway === "home" || c?.homeAway === "away") && c?.team?.id != null) {
        teamIdToHomeAway.set(String(c.team.id), c.homeAway);
      }
    }

    const result = {
      home: { confirmed: false, batters: [], startingPitcherRole: null },
      away: { confirmed: false, batters: [], startingPitcherRole: null },
    };
    const boxPlayers = data?.boxscore?.players ?? [];
    for (const teamEntry of boxPlayers) {
      const ha = teamIdToHomeAway.get(String(teamEntry?.team?.id));
      if (ha !== "home" && ha !== "away") continue;

      // Don't assume the batting category is always statistics[0] — find it
      // by content (any athlete with a real 1-9 batOrder) instead, the same
      // defensive approach parseGameLog uses for gamelog categories, which
      // this app has already been burned by assuming a stable index for
      // once before (see README's Known-issue history).
      const battingCategory =
        (teamEntry?.statistics ?? []).find((s) => (s?.athletes ?? []).some((a) => a?.batOrder >= 1)) ?? teamEntry?.statistics?.[0];
      const athletes = battingCategory?.athletes ?? [];
      const starters = athletes
        .filter((a) => a?.starter === true && Number.isFinite(a?.batOrder) && a.batOrder >= 1 && a.batOrder <= 9)
        .map((a) => ({
          id: String(a.athlete?.id),
          name: a.athlete?.displayName ?? a.athlete?.fullName ?? a.athlete?.shortName ?? "Unknown",
          battingOrder: a.batOrder,
          position: a.athlete?.position?.abbreviation ?? a.position?.abbreviation ?? null,
        }))
        .sort((x, y) => x.battingOrder - y.battingOrder);

      // The starting pitcher's own boxscore entry (confirmed live, same
      // response, same moment as the batting category above) carries a real
      // defensive position — "Starting Pitcher"/"SP" for a traditional
      // starter, but "Relief Pitcher"/"RP" was seen live for a probable
      // pitcher used as an opener/bulk-reliever (a real distinction this
      // project's own instructions asked for: "starter vs opener/bulk-
      // reliever role"). Only trustworthy once posted, same as the lineup —
      // `null` when nothing's posted yet, never guessed from the position
      // this pitcher normally plays.
      const pitchingCategory = (teamEntry?.statistics ?? []).find((s) => s !== battingCategory) ?? teamEntry?.statistics?.[1];
      const pitcherEntry = (pitchingCategory?.athletes ?? []).find((a) => a?.starter === true);
      const startingPitcherRole = pitcherEntry
        ? { id: String(pitcherEntry.athlete?.id), role: pitcherEntry.athlete?.position?.abbreviation ?? null }
        : null;

      result[ha] = { confirmed: starters.length > 0, batters: starters, startingPitcherRole };
    }

    if (!result.home.confirmed && !result.away.confirmed) {
      warn("getConfirmedLineup", `event ${espnEventId}: no confirmed lineup for either team yet (normal well before first pitch).`);
    }
    return result;
  } catch (err) {
    warn("getConfirmedLineup", `event ${espnEventId}: request failed — ${err.message}`);
    return {
      home: { confirmed: false, batters: [], startingPitcherRole: null },
      away: { confirmed: false, batters: [], startingPitcherRole: null },
    };
  }
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
    // Confirmed live (Sept 2026, across 5 different players on 5 different
    // teams): a response with ONLY a `filters` key — no `events`,
    // `seasonTypes`, or `statistics` at all — means this player genuinely
    // has zero games logged for the requested season, not a parse failure.
    // Two of the five had a real prior-season log but nothing yet this
    // season (hadn't been called up); the other three were every team's
    // lowest-usage roster spot, a third catcher, with nothing in either
    // season. getTeamBatters() lists the *whole* roster, not just regulars
    // — especially right after the September roster expansion pulls in a
    // batch of players with little or no MLB time — so this is routine,
    // not a bug, and not worth a warning. An actually-unexpected shape
    // (other keys present, still no categories) still gets one, since that
    // *would* indicate something worth investigating.
    const onlyFilters = Array.isArray(data?.filters) && Object.keys(data).length === 1;
    if (!onlyFilters) {
      warn(debugLabel, `no statistics categories found. Top-level keys: ${Object.keys(data ?? {}).join(", ")}`);
    }
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
      const meta = eventDates[ev.eventId];
      const dateStr = meta?.gameDate ?? ev.gameDate ?? ev.date ?? null;
      // Confirmed present on a live response's data.events[id]: an
      // `opponent` object with the team faced that game — used for "vs this
      // team" matchup history (see streaks.js's vsTeamSplit).
      const opponentTeamId = meta?.opponent?.id != null ? String(meta.opponent.id) : null;
      byEvent.set(ev.eventId, { eventId: ev.eventId, date: dateStr, opponentTeamId, presence, ...values });
    }
  }

  const appeared = [...byEvent.values()]
    .filter((g) =>
      g.presence != null
        ? g.presence > 0
        : Object.entries(g).some(([key, v]) => key !== "eventId" && key !== "date" && typeof v === "number" && v > 0)
    )
    .map(({ presence, ...rest }) => rest);
  if (appeared.length === 0 && byEvent.size > 0) {
    warn(debugLabel, `merged ${categories.length} categories (${byEvent.size} raw games) but every game was filtered out as "didn't appear" — likely an index problem, not a real 0-for-everything player.`);
  }

  // ESPN's per-game date (data.events[id].gameDate) is best-effort, not
  // guaranteed — a null date can't be placed in chronological order, and
  // silently sorting it to "oldest" (or worse, to wherever Map iteration
  // happened to put it) risks a confidently wrong streak: the actual most
  // recent game gets treated as old, an older game gets read as "today's."
  // A shorter, correctly-ordered log is worth more than a complete,
  // possibly-misordered one — drop undated games rather than guess.
  const games = appeared.filter((g) => g.date != null);
  if (games.length < appeared.length) {
    warn(debugLabel, `${appeared.length - games.length} of ${appeared.length} game(s) had no date from ESPN and were excluded from the log rather than risk a misordered streak.`);
  }

  games.sort((a, b) => new Date(b.date) - new Date(a.date));
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
      // AB requested as a real named stat (not just the presence check) so
      // "vs this team" batting average can be computed from the log.
      return parseGameLog(
        data,
        { H: ["H", "hits"], HR: ["HR", "homeRuns"], RBI: ["RBI", "RBIs"], AB: ["AB", "atBats"] },
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

/** Team-level batting AVG and strikeout rate (own batters' K%), for pitcher-K-prop matchup context. */
export async function getTeamBattingContext(teamId) {
  return cached(`mlb:teambat:${teamId}`, 6 * 60 * 60 * 1000, async () => {
    try {
      const data = await getJson(`${SITE_BASE}/teams/${teamId}/statistics`);
      // Confirmed live: `data.results.stats.categories` holds both a
      // "batting" and a "pitching" category, and both carry a strikeout
      // stat — "SO" for the team's own batters, "K" for their pitching
      // staff. A whole-tree search for either abbreviation (the old
      // findStatValue call) happened to land on the batting one only
      // because that category is listed first — correct by luck, not by
      // design, and one response reordering away from silently reporting
      // the wrong side. Scope explicitly to the "batting" category so this
      // always reads the lineup's own strikeouts.
      const categories = data?.results?.stats?.categories ?? [];
      const battingStats = categories.find((c) => c?.name === "batting")?.stats ?? [];
      const statValue = (abbr) => {
        const raw = battingStats.find((s) => s?.abbreviation === abbr)?.value;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
      };
      const strikeouts = statValue("SO");
      const plateAppearances = statValue("PA");
      return {
        avg: statValue("AVG"),
        strikeouts,
        plateAppearances,
        // K% = strikeouts / plate appearances — the standard way to talk
        // about a "strikeout-prone lineup," and a more direct signal for a
        // strikeout prop than team AVG (a low-average team isn't
        // necessarily a high-strikeout one, e.g. a lineup that makes weak
        // contact but rarely whiffs).
        kRate: strikeouts != null && plateAppearances ? strikeouts / plateAppearances : null,
      };
    } catch (err) {
      warn("getTeamBattingContext", `team ${teamId}: request failed — ${err.message}`);
      return { avg: null, strikeouts: null, plateAppearances: null, kRate: null };
    }
  });
}
