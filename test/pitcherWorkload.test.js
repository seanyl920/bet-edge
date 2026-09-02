// Covers the days-rest and opener/bulk-reliever-role math added to
// pitcherKTrends — the two Priority-1 pitcher-workload signals buildable
// without any new data source (days rest from getPitcherGameLog's existing
// dates; role from getConfirmedLineup's startingPitcherRole). Stubs
// globalThis.fetch by URL, same technique as mlbLineup.test.js, since
// mlbData.js's gamelog/team-stats fetchers aren't independently injectable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pitcherKTrends } from "../server/trends.js";
import { clearCache } from "../server/cache.js";

const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
});

// Shape confirmed by mlbData.js's own comments/parseGameLog: top-level
// labels/names shared across categories, one category per split, each
// event's stats[] positional against labels. Five starts, each 8 K, so
// avgK (8) clears K_HOT_AVG_MIN (7) regardless of the days-rest scenario
// under test — keeps each test isolated to the one thing it's checking.
function gamelogFixture(lastStartIso) {
  return {
    labels: ["IP", "SO"],
    statistics: [
      {
        events: [
          { eventId: "e1", stats: ["6.0", "8"] },
          { eventId: "e2", stats: ["6.0", "8"] },
          { eventId: "e3", stats: ["6.0", "8"] },
          { eventId: "e4", stats: ["6.0", "8"] },
          { eventId: "e5", stats: ["6.0", "8"] },
        ],
      },
    ],
    events: {
      e1: { gameDate: lastStartIso },
      e2: { gameDate: "2026-08-20T23:00:00Z" },
      e3: { gameDate: "2026-08-15T23:00:00Z" },
      e4: { gameDate: "2026-08-10T23:00:00Z" },
      e5: { gameDate: "2026-08-05T23:00:00Z" },
    },
  };
}

function stubFetchFor(lastStartIso) {
  clearCache("savant:"); // see the K-BB% tests below for why this matters across tests
  globalThis.fetch = async (url) => {
    if (url.includes("/gamelog")) return { ok: true, json: async () => gamelogFixture(lastStartIso) };
    if (url.includes("baseballsavant.mlb.com")) {
      // pitcherKTrends now also looks up a Savant profile — not what this
      // file tests, so a non-CSV body is enough: savantData.js fails that
      // fetch loudly internally and getPitcherProfileByName resolves to
      // null, same as "not found," which every test here already treats
      // as the neutral/default case.
      return { ok: true, text: async () => "not csv" };
    }
    // Team batting-context lookup — empty is fine, getTeamBattingContext is
    // defensive about a missing shape and returns nulls, not a throw.
    return { ok: true, json: async () => ({}) };
  };
}

// getPitcherGameLog/getTeamBattingContext are cached by id (see
// server/cache.js) — a shared in-memory Map that outlives any one test, so
// every test here uses its own pitcher id to avoid one test's stubbed
// response getting served (stale) to a later test that stubbed something
// different for the "same" id.
function baseArgs(pitcherId, overrides = {}) {
  return {
    event: { id: "evt-1", date: "2026-09-02T22:40:00Z", home: { name: "Home Team" }, away: { name: "Away Team" } },
    pitcher: { id: pitcherId, name: "Test Pitcher" },
    pitcherTeamName: "Home Team",
    oppTeamId: `opp-${pitcherId}`,
    oppTeamName: "Opponent",
    park: null,
    weather: null,
    startingPitcherRole: null,
    ...overrides,
  };
}

test("pitcherKTrends computes days rest from the pitcher's own game log", async () => {
  stubFetchFor("2026-08-30T23:00:00Z"); // 3 days before the 2026-09-02 game
  const [trend] = await pitcherKTrends(baseArgs("pitcher-rest-3"));
  assert.equal(trend.daysRest, 3);
  assert.match(trend.workloadNote, /3 days rest/);
});

test("pitcherKTrends leaves daysRest null (never 0 or guessed) when there's no prior start to measure from", async () => {
  globalThis.fetch = async (url) => {
    if (url.includes("/gamelog")) return { ok: true, json: async () => ({ labels: ["IP", "SO"], statistics: [{ events: [] }], events: {} }) };
    return { ok: true, json: async () => ({}), text: async () => "not csv" };
  };
  const trends = await pitcherKTrends(baseArgs("pitcher-no-log"));
  // Empty log means parseGameLog returns [] and pitcherKTrends bails before
  // ever computing streak/daysRest at all — confirms it doesn't fabricate a
  // days-rest number from nothing rather than actually asserting on `null`.
  assert.deepEqual(trends, []);
});

test("pitcherKTrends does NOT flag short rest when the gap is a normal rotation turn", async () => {
  stubFetchFor("2026-08-27T23:00:00Z"); // 6 days before the game — normal
  const [trend] = await pitcherKTrends(baseArgs("pitcher-rest-6"));
  assert.equal(trend.daysRest, 6);
  assert.equal(trend.workloadNote, null);
});

test("pitcherKTrends applies the opener-role penalty and note when the confirmed role isn't SP", async () => {
  stubFetchFor("2026-08-27T23:00:00Z");
  const pitcherId = "pitcher-opener-role";
  const withoutRole = await pitcherKTrends(baseArgs(pitcherId));
  const withOpenerRole = await pitcherKTrends(baseArgs(pitcherId, { startingPitcherRole: { id: pitcherId, role: "RP" } }));

  assert.equal(withOpenerRole[0].confirmedRole, "RP");
  assert.match(withOpenerRole[0].workloadNote, /not a traditional start/);
  assert.ok(withOpenerRole[0].score < withoutRole[0].score, "an opener/bulk-reliever role must score lower than an unknown/traditional-starter role");
});

test("pitcherKTrends ignores startingPitcherRole when its id doesn't match this pitcher (a substitution)", async () => {
  stubFetchFor("2026-08-27T23:00:00Z");
  // Confirmed role belongs to a DIFFERENT pitcher id — must not be
  // misattributed to the one this trend is actually about.
  const [trend] = await pitcherKTrends(baseArgs("pitcher-substitution", { startingPitcherRole: { id: "someone-else", role: "RP" } }));
  assert.equal(trend.confirmedRole, null);
});

test("pitcherKTrends computes K-BB% from Savant's kPercent/bbPercent when a profile is found", async () => {
  clearCache("savant:");
  globalThis.fetch = async (url) => {
    if (url.includes("/gamelog")) return { ok: true, json: async () => gamelogFixture("2026-08-27T23:00:00Z") };
    if (url.includes("baseballsavant.mlb.com")) {
      // Real CSV shape, values chosen so K-BB% has an unambiguous expected
      // result: 28.9 - 7.1 = 21.8.
      return {
        ok: true,
        text: async () =>
          `"last_name, first_name","player_id","year","k_percent","bb_percent","whiff_percent"\n"Pitcher, Test",42604,2026,28.9,7.1,28.1\n`,
      };
    }
    return { ok: true, json: async () => ({}) };
  };
  const [trend] = await pitcherKTrends(baseArgs("42604"));
  assert.ok(trend.savant, "expected a matched Savant profile");
  assert.equal(trend.savant.kMinusBBPercent, 21.8);
});

test("pitcherKTrends leaves kMinusBBPercent null (never 0) when no Savant profile is found", async () => {
  stubFetchFor("2026-08-27T23:00:00Z"); // stubFetchFor's Savant response is "not csv" -> no match
  const [trend] = await pitcherKTrends(baseArgs("pitcher-no-savant"));
  assert.equal(trend.savant, null);
});
