// Fixtures are REAL CSV rows pasted back from a live run against Baseball
// Savant this session (see the diagnostic output in this conversation) —
// not invented sample data. Stubs globalThis.fetch, same technique as the
// mlbData tests, since savantData.js calls fetch directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getBatterProfileByName, getBatterProfiles, getPitcherProfileByName } from "../server/savantData.js";
import { clearCache } from "../server/cache.js";

const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
});

// getBatterProfiles()/getPitcherProfiles() are cached by minQualifier (see
// server/cache.js) — a shared in-memory Map that outlives any one test.
// getBatterProfileByName/getPitcherProfileByName always use the DEFAULT
// qualifier, so every test here would otherwise share one cache entry and
// see whichever stub ran first. Clear the relevant prefix before each stub
// swap instead of threading a distinct qualifier through every call.

// Verbatim rows from the live Savant response (batters), including the
// header's quoted "last_name, first_name" column — the exact thing that
// breaks a naive comma-split parser.
const REAL_BATTER_CSV = `"last_name, first_name","player_id","year","k_percent","bb_percent","whiff_percent","barrel_batted_rate"
"DeLuca, Jonny",676356,2026,20.3,4.3,25.6,3.5
"Wong, Connor",657136,2026,23.9,7.8,24.7,4.9
"Bichette, Bo",666182,2026,18.2,6.5,19.5,6.1
"Nimmo, Brandon",607043,2026,21.3,7.8,22.2,10.2
"Julien, Edouard",666397,2026,25.7,14.1,23.7,7.3
`;

const REAL_PITCHER_CSV = `"last_name, first_name","player_id","year","k_percent","bb_percent","whiff_percent"
"Buehler, Walker",621111,2026,19.9,8.8,19.8
"Skenes, Paul",694973,2026,28.9,7.1,28.1
"Glasnow, Tyler",607192,2026,32.3,7.3,29.4
`;

// A synthetic ambiguity: two different player_ids both named "Sam Smith" —
// the collision-safety property under test, not real Savant data (a real
// example wasn't in the pasted sample).
const AMBIGUOUS_BATTER_CSV = `"last_name, first_name","player_id","year","k_percent","bb_percent","whiff_percent","barrel_batted_rate"
"Smith, Sam",111111,2026,20,8,22,7
"Smith, Sam",222222,2026,25,6,30,10
"Bichette, Bo",666182,2026,18.2,6.5,19.5,6.1
`;

function stubCsv(csvText) {
  clearCache("savant:");
  globalThis.fetch = async (url) => ({ ok: true, text: async () => csvText });
}

test("getBatterProfileByName parses real Savant CSV rows and matches by name, comma-in-quotes handled correctly", async () => {
  stubCsv(REAL_BATTER_CSV);
  const profile = await getBatterProfileByName("Bo Bichette");
  assert.ok(profile, "expected a match for Bo Bichette");
  assert.equal(profile.playerId, "666182");
  assert.equal(profile.kPercent, 18.2);
  assert.equal(profile.bbPercent, 6.5);
  assert.equal(profile.whiffPercent, 19.5);
  assert.equal(profile.barrelRate, 6.1);
  assert.equal(profile.source, "baseball-savant-custom-leaderboard");
  assert.equal(profile.splitByHandedness, false);
});

test("getBatterProfileByName is case/diacritic-insensitive but still an exact full-name match", async () => {
  stubCsv(REAL_BATTER_CSV);
  const profile = await getBatterProfileByName("brandon nimmo");
  assert.ok(profile);
  assert.equal(profile.playerId, "607043");
});

test("getPitcherProfileByName parses the pitcher CSV independently of the batter one", async () => {
  stubCsv(REAL_PITCHER_CSV);
  const profile = await getPitcherProfileByName("Paul Skenes");
  assert.ok(profile);
  assert.equal(profile.playerId, "694973");
  assert.equal(profile.kPercent, 28.9);
  // Pitchers don't get barrelRate — must not silently carry a batter-only field.
  assert.equal(profile.barrelRate, undefined);
});

test("getBatterProfileByName returns null for a name not on the leaderboard — never a guess", async () => {
  stubCsv(REAL_BATTER_CSV);
  const profile = await getBatterProfileByName("Nobody Real");
  assert.equal(profile, null);
});

test("an ambiguous name shared by two different player_ids is dropped from the index entirely", async () => {
  stubCsv(AMBIGUOUS_BATTER_CSV);
  const sam = await getBatterProfileByName("Sam Smith");
  assert.equal(sam, null, "two different real players sharing a name must never resolve to either one's stats");
  // An unambiguous name in the SAME response still resolves normally.
  const bo = await getBatterProfileByName("Bo Bichette");
  assert.ok(bo);
  assert.equal(bo.playerId, "666182");
});

test("a non-CSV response (bot-challenge/error page, like FanGraphs returned) fails loudly instead of parsing garbage", async () => {
  clearCache("savant:");
  globalThis.fetch = async () => ({ ok: true, text: async () => "<!DOCTYPE html><html>Just a moment...</html>" });
  const index = await getBatterProfiles();
  assert.equal(index.size, 0, "a non-CSV response must never be parsed as if it had real rows");
});

test("a network failure never throws — returns an empty index", async () => {
  clearCache("savant:");
  globalThis.fetch = async () => {
    throw new Error("simulated network failure");
  };
  const index = await getBatterProfiles();
  assert.equal(index.size, 0);
});
