// First-ever test coverage for oddsApi.js. Written alongside the fix for a
// real user-reported problem (monthly Odds API quota exhausted): getOdds()/
// getPlayerProps() now persist their cache to disk (see cache.js) so a
// stopped-and-restarted dev server doesn't force an immediate, quota-
// costing re-fetch. ODDS_CACHE_FILE points this at a throwaway file so
// these tests never touch the real data/oddsCache.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "oddsapi-test-"));
process.env.ODDS_CACHE_FILE = path.join(dir, "oddsCache.json");
process.env.ODDS_API_KEY = "test-key";

const { getOdds, getPlayerProps, hasOddsApiKey } = await import("../server/oddsApi.js");
const { clearCache } = await import("../server/cache.js");
const { SPORTS } = await import("../server/sports.js");

const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
});

function fakeHeaders(remaining = "450", used = "50") {
  return { get: (name) => (name === "x-requests-remaining" ? remaining : name === "x-requests-used" ? used : null) };
}

test("hasOddsApiKey reflects whether ODDS_API_KEY is actually set", () => {
  assert.equal(hasOddsApiKey(), true); // set at the top of this file
});

test("getOdds captures the quota headers from the real response", async () => {
  clearCache();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, headers: fakeHeaders("437", "63"), json: async () => [{ id: "evt-1" }] };
  };
  const result = await getOdds(SPORTS.nfl);
  assert.equal(result.quota.remaining, "437");
  assert.equal(result.quota.used, "63");
  assert.equal(calls, 1);
});

test("getOdds survives the in-memory cache being forgotten — a restart must not force an immediate re-fetch (the actual quota-exhaustion fix)", async () => {
  clearCache();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, headers: fakeHeaders(), json: async () => [{ id: `evt-restart-${calls}` }] };
  };
  const first = await getOdds(SPORTS.nba);
  clearCache(); // simulates a `node server/index.js` restart forgetting the in-memory store
  const second = await getOdds(SPORTS.nba);
  assert.equal(calls, 1, "must be restored from the on-disk cache, not re-fetched, after a simulated restart");
  assert.deepEqual(second.events, first.events);
});

test("getPlayerProps also survives a simulated restart (a per-event, credit-costing call)", async () => {
  clearCache();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, headers: fakeHeaders(), json: async () => ({ id: "props-evt-1" }) };
  };
  await getPlayerProps(SPORTS.mlb, "odds-evt-1", "pitcher_strikeouts");
  clearCache();
  await getPlayerProps(SPORTS.mlb, "odds-evt-1", "pitcher_strikeouts");
  assert.equal(calls, 1);
});

test("getOdds throws a NO_ODDS_KEY-coded error (never fetches) when no key is configured", async () => {
  const original = process.env.ODDS_API_KEY;
  delete process.env.ODDS_API_KEY;
  try {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      throw new Error("must not be called with no key configured");
    };
    await assert.rejects(() => getOdds(SPORTS.nfl), (err) => err.code === "NO_ODDS_KEY");
    assert.equal(called, false);
  } finally {
    process.env.ODDS_API_KEY = original;
  }
});

test("getOdds propagates a real API error with its HTTP status", async () => {
  clearCache();
  globalThis.fetch = async () => ({ ok: false, status: 429, statusText: "Too Many Requests", headers: fakeHeaders(), text: async () => "quota exceeded" });
  await assert.rejects(() => getOdds(SPORTS.nfl, { markets: "totals" }), (err) => err.status === 429);
});

test.after(async () => {
  await rm(dir, { recursive: true, force: true });
});
