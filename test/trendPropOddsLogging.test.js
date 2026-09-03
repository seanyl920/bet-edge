// Confirmed real bug (external review, Sept 2026): prediction logging used
// to live only inside dailyParlay.js's bounded daily scan — a user manually
// clicking "check odds" on a TrendFeed.jsx card called getTrendPropOdds()
// directly and got a fully-priced result that never reached
// predictionLog.jsonl. This exercises getTrendPropOdds() itself (the
// actual shared pricing function every caller goes through) end-to-end —
// ESPN scoreboard, The Odds API's bulk h2h + player-props endpoints all
// stubbed by URL — and confirms a call through THIS path alone (no
// dailyParlay involvement at all) produces a real predictionLog entry.
// getTrendFeedFn is injected to skip rebuilding the whole trend feed (a
// large ESPN/Savant call tree unrelated to what this test checks) — the
// trend it returns is what getTrendPropOdds looks up to build the logged
// snapshot's context.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "trendodds-test-"));
process.env.PREDICTION_LOG_FILE = path.join(dir, "predictionLog.jsonl");
process.env.ODDS_API_KEY = "test-key";

const { getTrendPropOdds } = await import("../server/trends.js");
const { readPredictionLog } = await import("../server/predictionLog.js");
const { SPORTS } = await import("../server/sports.js");
const { clearCache } = await import("../server/cache.js");

const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
});

const FUTURE_ISO = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour from now

function fakeHeaders() {
  return { get: () => null };
}

function stubFetch() {
  clearCache(); // clear everything — odds/scoreboard caches would otherwise leak between test files sharing a process
  globalThis.fetch = async (url) => {
    if (url.includes("site.api.espn.com") && url.includes("/scoreboard")) {
      return {
        ok: true,
        headers: fakeHeaders(),
        json: async () => ({
          events: [
            {
              id: "evt-checkodds-1",
              date: FUTURE_ISO,
              name: "Away Team at Home Team",
              status: { type: { name: "STATUS_SCHEDULED", completed: false } },
              competitions: [
                {
                  status: { type: { name: "STATUS_SCHEDULED" } },
                  venue: { fullName: "Test Park", address: {} },
                  competitors: [
                    { homeAway: "home", team: { id: "30", displayName: "Home Team", abbreviation: "HHH" }, score: "0" },
                    { homeAway: "away", team: { id: "21", displayName: "Away Team", abbreviation: "AAA" }, score: "0" },
                  ],
                },
              ],
            },
          ],
        }),
      };
    }
    if (url.includes("api.the-odds-api.com") && url.includes("/events/") && url.includes("/odds?")) {
      // getPlayerProps
      return {
        ok: true,
        headers: fakeHeaders(),
        json: async () => ({
          bookmakers: [
            {
              title: "BookA",
              markets: [
                {
                  key: "batter_hits",
                  outcomes: [
                    { name: "Over", description: "Test Player", point: 1.5, price: -130 },
                    { name: "Under", description: "Test Player", point: 1.5, price: 110 },
                  ],
                },
              ],
            },
          ],
        }),
      };
    }
    if (url.includes("api.the-odds-api.com") && url.includes("/odds/?")) {
      // getOdds (bulk h2h) — locates the odds event id for the props call above
      return {
        ok: true,
        headers: fakeHeaders(),
        json: async () => [{ id: "odds-evt-checkodds-1", home_team: "Home Team", away_team: "Away Team", commence_time: FUTURE_ISO, bookmakers: [] }],
      };
    }
    throw new Error(`unstubbed URL in trendPropOddsLogging.test.js: ${url}`);
  };
}

function stubTrendFeed() {
  return async () => ({
    trends: [
      {
        eventId: "evt-checkodds-1",
        commenceTime: FUTURE_ISO,
        matchup: "Away Team @ Home Team",
        type: "hitStreak",
        player: { id: "player-checkodds-1", name: "Test Player" },
        streakValue: 7,
        matchupLabel: "favorable matchup",
        score: 10,
      },
    ],
  });
}

test("getTrendPropOdds logs a prediction on its own — no dailyParlay involvement at all", async () => {
  stubFetch();
  const result = await getTrendPropOdds(SPORTS.mlb, "evt-checkodds-1", "Test Player", "hitStreak", { getTrendFeedFn: stubTrendFeed() });

  assert.equal(result.available, true);
  assert.ok(result.outcomes.length > 0, "expected at least one priced outcome");

  const records = await readPredictionLog();
  const logged = records.filter((r) => r.subjectId === "player-checkodds-1");
  assert.ok(logged.length > 0, "getTrendPropOdds must log a prediction directly — this is the exact gap the review found");
  const over = logged.find((r) => r.side === "Over");
  assert.ok(over, "expected the Over 1.5 outcome to be logged");
  assert.equal(over.leg.eventId, "evt-checkodds-1");
  assert.equal(over.leg.context.playerId, "player-checkodds-1");
  assert.equal(over.leg.context.streakValue, 7);
});

test.after(async () => {
  await rm(dir, { recursive: true, force: true });
});
