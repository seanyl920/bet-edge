// Confirmed real bug (external review, Sept 2026): edgeCandidates() filters
// to today's local calendar day, but trendCandidates() scanned the raw
// today+tomorrow trend window unfiltered — a September 3 daily-parlay build
// could pick up a September 4 prop. trendCandidates() is exported (only) so
// this can verify the filter directly, with getTrendFeedFn/getTrendPropOddsFn
// injected instead of exercising the real ESPN/Odds-API pipeline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { trendCandidates } from "../server/dailyParlay.js";
import { localDateKey } from "../server/dateUtil.js";

function trend({ id, hoursFromNow, name = "Test Player" }) {
  const commenceTime = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
  return {
    eventId: id,
    commenceTime,
    matchup: "Away @ Home",
    type: "hitStreak",
    player: { id, name },
    streakValue: 6,
    matchupLabel: "favorable matchup",
    score: 9,
  };
}

test("trendCandidates only ever checks odds for today's trends, never tomorrow's", async () => {
  const todayTrend = trend({ id: "evt-today", hoursFromNow: 0 }); // right now — always today, by construction
  // +25h guarantees the next calendar day (or later) regardless of what
  // time of day "now" happens to be when this test runs — a fixed
  // multiplier of a day-fraction (e.g. "+1.2 days") would be flaky near a
  // local midnight boundary.
  const tomorrowTrend = trend({ id: "evt-tomorrow", hoursFromNow: 25, name: "Tomorrow Player" });

  const checkedEventIds = [];
  const stubGetTrendPropOddsFn = async (sport, eventId) => {
    checkedEventIds.push(eventId);
    return { available: false, reason: "event-not-found", outcomes: [] };
  };

  await trendCandidates({
    getTrendFeedFn: async () => ({ trends: [todayTrend, tomorrowTrend] }),
    getTrendPropOddsFn: stubGetTrendPropOddsFn,
  });

  assert.deepEqual(checkedEventIds, ["evt-today"], "only today's trend should ever reach getTrendPropOdds — tomorrow's must be filtered out first");
});

test("trendCandidates still processes every one of today's trends when there's no tomorrow trend at all", async () => {
  const trends = [trend({ id: "evt-a", hoursFromNow: 0 }), trend({ id: "evt-b", hoursFromNow: 0 })];
  const checkedEventIds = [];

  await trendCandidates({
    getTrendFeedFn: async () => ({ trends }),
    getTrendPropOddsFn: async (sport, eventId) => {
      checkedEventIds.push(eventId);
      return { available: false, reason: "event-not-found", outcomes: [] };
    },
  });

  assert.deepEqual(checkedEventIds.sort(), ["evt-a", "evt-b"]);
});

test("sanity: the fixture's own +25h offset actually lands on a different calendar day than +0h", () => {
  const today = trend({ id: "x", hoursFromNow: 0 });
  const tomorrow = trend({ id: "y", hoursFromNow: 25 });
  assert.notEqual(localDateKey(today.commenceTime), localDateKey(tomorrow.commenceTime), "fixture design check, not the real bug — if this fails, the test above proves nothing");
});
