// Baseball Savant custom-leaderboard CSV adapter — Priority 2's first real
// data source. Kept entirely separate from prediction logic (this
// project's own instruction #2): this file only fetches and shapes raw
// stats, never decides what they mean for a bet.
//
// Verified live (Sept 2026, real responses pasted back from the user's own
// machine — this sandbox has no outbound access to either site):
// baseballsavant.mlb.com/leaderboard/custom with csv=true returns real,
// unauthenticated CSV — no login, no bot challenge, clean columns
// (last_name/first_name as one quoted "last, first" field, player_id,
// year, then whichever stat keys are requested via `selections`).
// FanGraphs, by contrast, returned a Cloudflare bot-challenge page ("Just a
// moment...", 403) on every endpoint tried — deliberately NOT built here;
// bypassing that would mean impersonating a real browser to defeat bot
// protection, not just reading a public export.
//
// SEASON-LEVEL ONLY, NOT SPLIT BY HANDEDNESS. A handedness-split query was
// attempted live and did not come back split (the params tried were
// unverified guesses) — do not assume any `split=` parameter works until
// it's actually confirmed against a live response. Handedness splits
// (batter vs LHP/RHP, pitcher vs LHB/RHB) are a real gap, not built yet —
// see README.
//
// IDENTIFIER MISMATCH (confirmed, important): Savant's player_id is MLB
// Advanced Media's own id (e.g. Aaron Judge = 592450) — NOT the same
// numbering as ESPN's athlete id used everywhere else in this app (e.g.
// Francisco Lindor's confirmed ESPN id, from this session's own lineup
// diagnostic, was 32129 — nowhere close to his real MLBAM id, 596019).
// There is no shared numeric key between this file and mlbData.js/
// trends.js. Matching here is by exact normalized full name only — never
// fuzzy, unlike the looser namesMatch() trends.js uses for odds-prop
// matching, since misattributing one player's K%/BB%/whiff% to a
// different player of the same or similar name is a worse failure than
// just not finding a match. Any name that maps to more than one Savant
// row (two different real players sharing a normalized name) is dropped
// from the lookup table entirely rather than guessed — see
// buildNameIndex's dedupe check.

import { cached } from "./cache.js";

const LEADERBOARD_BASE = "https://baseballsavant.mlb.com/leaderboard/custom";
const FETCH_TIMEOUT_MS = 10000;
// Season aggregates move slowly (one game barely nudges a full-season
// rate) — cache well past this app's usual TTLs to avoid hammering an
// endpoint that has no documented rate limit to respect.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export const SAVANT_SOURCE = "baseball-savant-custom-leaderboard";

function warn(fn, detail) {
  console.warn(`[savantData] ${fn}: ${detail}`);
}

/**
 * Minimal CSV parser handling double-quoted fields with embedded commas
 * (Savant's own `"last, first"` name column needs this — a naive
 * split(",") breaks every row on that field alone). Doesn't handle
 * escaped/doubled quotes inside a quoted field — not seen in the live
 * sample this was built against, so not worth the extra complexity for an
 * export this narrowly scoped; if a name ever contains a literal `"`,
 * that row would parse wrong, not crash.
 */
function parseCsvLine(line) {
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "," && !inQuotes) {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function parseCsv(text) {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((h, i) => (row[h] = values[i]));
    return row;
  });
}

// Confirmed real bug (external review, Sept 2026): Number("") and
// Number(" ") are both 0 — a genuinely finite number, so the old
// `Number.isFinite(n) ? n : null` check let a blank CSV cell (Savant
// omitting a stat for a player who didn't qualify for it, or any other
// reason a cell comes back empty) through as a real, fabricated 0%
// strikeout/walk/whiff rate instead of "unavailable." Reproduced with a
// blank-field fixture. Trim and explicitly treat an empty string as no
// value before ever calling Number() on it.
function toNum(v) {
  if (v == null) return null;
  const trimmed = String(v).trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function normalizeName(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents (e.g. a name with a combining tilde)
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .trim();
}

/** Savant's name column is `"Last, First"` — flip it to a normal "First Last" for matching against ESPN's displayName. */
function toFirstLast(lastCommaFirst) {
  const parts = String(lastCommaFirst || "").split(",");
  if (parts.length !== 2) return lastCommaFirst;
  return `${parts[1].trim()} ${parts[0].trim()}`;
}

async function fetchLeaderboardCsv(type, { minQualifier, selections }) {
  const params = new URLSearchParams({
    year: String(new Date().getUTCFullYear()),
    type,
    filter: "",
    min: String(minQualifier),
    selections,
    chart: "false",
    x: selections.split(",")[0],
    y: selections.split(",")[1] ?? selections.split(",")[0],
    r: "no",
    chartType: "beeswarm",
    csv: "true",
  });
  const url = `${LEADERBOARD_BASE}?${params.toString()}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; bet-edge/1.0; personal research tool)" },
    });
    if (!res.ok) throw new Error(`Savant ${res.status} ${res.statusText} for ${url}`);
    const text = await res.text();
    // A bot-challenge or error page comes back as HTML, not CSV — this is
    // exactly the signal that stopped FanGraphs cold. Fail loudly here
    // rather than silently parsing an HTML page as if it had real columns.
    if (!text.trim().startsWith('"')) {
      throw new Error(`unexpected non-CSV response (first 100 chars: ${JSON.stringify(text.slice(0, 100))})`);
    }
    return parseCsv(text);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Builds a name -> profile lookup from raw CSV rows, dropping any
 * normalized name that maps to more than one distinct player_id — refusing
 * to guess between two real players who happen to share a name, rather
 * than silently attaching one player's stats to another.
 */
function buildNameIndex(rows, extraFields = {}) {
  const byName = new Map(); // normalizedName -> { profile, playerIds: Set }
  for (const row of rows) {
    const displayName = toFirstLast(row["last_name, first_name"]);
    const key = normalizeName(displayName);
    if (!key) continue;
    const profile = {
      playerId: row.player_id ?? null,
      name: displayName,
      season: toNum(row.year),
      kPercent: toNum(row.k_percent),
      bbPercent: toNum(row.bb_percent),
      whiffPercent: toNum(row.whiff_percent),
      source: SAVANT_SOURCE,
      splitByHandedness: false, // see file header — never claim a split that wasn't verified
      fetchedAt: new Date().toISOString(),
    };
    // extraFields maps { outputFieldName: csvColumnName } — the two don't
    // match for barrel_batted_rate -> barrelRate, and assuming they did
    // (an earlier version of this function did exactly that) silently
    // produced `null` for every batter instead of the real barrel rate.
    for (const [outField, csvCol] of Object.entries(extraFields)) profile[outField] = toNum(row[csvCol]);

    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, { profile, playerIds: new Set([profile.playerId]) });
    } else {
      existing.playerIds.add(profile.playerId);
    }
  }

  const index = new Map();
  let dropped = 0;
  for (const [key, { profile, playerIds }] of byName) {
    if (playerIds.size > 1) {
      dropped++;
      continue; // ambiguous — two different real players, same normalized name
    }
    index.set(key, profile);
  }
  if (dropped > 0) warn("buildNameIndex", `dropped ${dropped} ambiguous name(s) shared by more than one player_id — never guessed which is which.`);
  return index;
}

/**
 * Season-level K%/BB%/whiff%/barrel-rate for qualified batters, keyed by
 * normalized full name. `minQualifier` follows Savant's own `min=` filter
 * (a batted-ball-event-style qualification threshold, not a literal PA
 * count this export exposes per row — Savant's leaderboard UI treats it as
 * a minimum-sample gate, but the exact unit was never independently
 * confirmed; treat it as "Savant's own small-sample floor," not a number
 * this app can display per player).
 */
export async function getBatterProfiles({ minQualifier = 100 } = {}) {
  return cached(`savant:batters:${minQualifier}`, CACHE_TTL_MS, async () => {
    try {
      const rows = await fetchLeaderboardCsv("batter", {
        minQualifier,
        selections: "k_percent,bb_percent,whiff_percent,barrel_batted_rate",
      });
      return buildNameIndex(rows, { barrelRate: "barrel_batted_rate" });
    } catch (err) {
      warn("getBatterProfiles", `request failed — ${err.message}`);
      return new Map();
    }
  });
}

/** Season-level K%/BB%/whiff% for qualified pitchers — same caveats as getBatterProfiles. */
export async function getPitcherProfiles({ minQualifier = 50 } = {}) {
  return cached(`savant:pitchers:${minQualifier}`, CACHE_TTL_MS, async () => {
    try {
      const rows = await fetchLeaderboardCsv("pitcher", {
        minQualifier,
        selections: "k_percent,bb_percent,whiff_percent",
      });
      return buildNameIndex(rows);
    } catch (err) {
      warn("getPitcherProfiles", `request failed — ${err.message}`);
      return new Map();
    }
  });
}

/** Look up one batter's profile by ESPN displayName — null (never a guess) if not found or ambiguous. */
export async function getBatterProfileByName(name) {
  const index = await getBatterProfiles();
  return index.get(normalizeName(name)) ?? null;
}

/** Look up one pitcher's profile by ESPN displayName — null (never a guess) if not found or ambiguous. */
export async function getPitcherProfileByName(name) {
  const index = await getPitcherProfiles();
  return index.get(normalizeName(name)) ?? null;
}
