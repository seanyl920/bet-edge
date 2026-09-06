// First-ever test coverage for postmortem.js — the actual bet-grading
// logic. Written alongside a self-audit fix: gradeEdgeLeg's predicted-text
// used `ctx.marketProb ?? 0`, turning a genuinely real `null` (no book
// quoted both sides of this market — see edges.js's consensusAndBest) into
// a fabricated "0%", which reads as "the market said this side had no
// chance" instead of "unknown." Also added explicit push detection/notes
// for moneyline ties and exact-integer spread covers, matching the
// existing pattern for trend-leg pushes (isPush).
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeBet } from "../server/postmortem.js";

function edgeBet(overrides = {}) {
  return {
    sport: "nfl",
    legs: [
      {
        sport: "nfl",
        eventId: "evt-1",
        commenceTime: "2026-09-10T17:00:00Z",
        market: "moneyline",
        selection: "Home",
        context: { kind: "edge", side: "home", modelProb: 0.6, marketProb: 0.55 },
        ...overrides,
      },
    ],
  };
}

function scoreboardFn(events) {
  return async () => events;
}

test("analyzeBet (moneyline) grades a win/loss correctly off the final score", async () => {
  const bet = edgeBet();
  const result = await analyzeBet(bet, {
    getScoreboardFn: scoreboardFn([{ id: "evt-1", completed: true, home: { score: 24 }, away: { score: 20 } }]),
  });
  assert.equal(result.legs[0].hit, true, "home won outright, home side must be a hit");
});

test("analyzeBet (moneyline) never fabricates market/model probability as 0% when genuinely unavailable", async () => {
  // Confirmed real bug: ctx.marketProb can be a real null (no book quoted
  // both sides — see edges.js) — the note used to say "vs market 0%,"
  // which reads as a real, fabricated number.
  const bet = edgeBet({ context: { kind: "edge", side: "home", modelProb: 0.6, marketProb: null } });
  const result = await analyzeBet(bet, {
    getScoreboardFn: scoreboardFn([{ id: "evt-1", completed: true, home: { score: 24 }, away: { score: 20 } }]),
  });
  assert.match(result.legs[0].note, /market unavailable/);
  assert.ok(!result.legs[0].note.includes("market 0%"), "must never show a fabricated 0% for a genuinely missing market probability");
});

test("analyzeBet (moneyline) treats a tie as a push — hit is null, and the note says so explicitly", async () => {
  const bet = edgeBet();
  const result = await analyzeBet(bet, {
    getScoreboardFn: scoreboardFn([{ id: "evt-1", completed: true, home: { score: 17 }, away: { score: 17 } }]),
  });
  assert.equal(result.legs[0].hit, null);
  assert.match(result.legs[0].note, /push/);
});

test("analyzeBet (spread) grades a cover correctly, home favorite", async () => {
  const bet = edgeBet({ market: "spread", context: { kind: "edge", side: "home", line: -3.5 } });
  const result = await analyzeBet(bet, {
    getScoreboardFn: scoreboardFn([{ id: "evt-1", completed: true, home: { score: 24 }, away: { score: 20 } }]), // home won by 4, covers -3.5
  });
  assert.equal(result.legs[0].hit, true);
});

test("analyzeBet (spread) does NOT cover when the margin falls short of the line", async () => {
  const bet = edgeBet({ market: "spread", context: { kind: "edge", side: "home", line: -3.5 } });
  const result = await analyzeBet(bet, {
    getScoreboardFn: scoreboardFn([{ id: "evt-1", completed: true, home: { score: 21 }, away: { score: 20 } }]), // home won by 1, does NOT cover -3.5
  });
  assert.equal(result.legs[0].hit, false);
});

test("analyzeBet (spread) treats an exact integer-line cover as a push, not a win or loss", async () => {
  // Real, non-trivial outcome for an integer spread (see elo.js's
  // pushProbability) — margin lands exactly on the line.
  const bet = edgeBet({ market: "spread", context: { kind: "edge", side: "home", line: -3 } });
  const result = await analyzeBet(bet, {
    getScoreboardFn: scoreboardFn([{ id: "evt-1", completed: true, home: { score: 23 }, away: { score: 20 } }]), // home won by exactly 3
  });
  assert.equal(result.legs[0].hit, null);
  assert.match(result.legs[0].note, /push/);
});

test("analyzeBet returns hit:null with a clear note when the game isn't final yet", async () => {
  const bet = edgeBet();
  const result = await analyzeBet(bet, {
    getScoreboardFn: scoreboardFn([{ id: "evt-1", completed: false, home: { score: null }, away: { score: null } }]),
  });
  assert.equal(result.legs[0].hit, null);
  assert.match(result.legs[0].note, /not final/i);
});

test("analyzeBet returns hit:null (never throws) when the scoreboard fetch itself fails", async () => {
  const bet = edgeBet();
  const result = await analyzeBet(bet, {
    getScoreboardFn: async () => {
      throw new Error("simulated ESPN outage");
    },
  });
  assert.equal(result.legs[0].hit, null);
  assert.match(result.legs[0].note, /Couldn't reach ESPN/);
});

test("analyzeBet (trend leg) grades a hit streak Over correctly and computes summary counts", async () => {
  const bet = {
    sport: "mlb",
    legs: [
      {
        sport: "mlb",
        eventId: "evt-2",
        market: "hitStreak",
        context: { kind: "trend", playerId: "p1", trendType: "hitStreak", propSide: "Over", propPoint: 1.5 },
      },
    ],
  };
  const result = await analyzeBet(bet, {
    getBatterGameLogFn: async () => [{ eventId: "evt-2", H: 2 }],
  });
  assert.equal(result.legs[0].hit, true);
  assert.match(result.summary, /1\/1 graded leg\(s\) correct/);
});

test("analyzeBet (trend leg) treats an exact-line stat as a push, not a hit", async () => {
  const bet = {
    sport: "mlb",
    legs: [
      {
        sport: "mlb",
        eventId: "evt-2",
        market: "pitcherK",
        context: { kind: "trend", playerId: "p2", trendType: "pitcherK", propSide: "Over", propPoint: 6 },
      },
    ],
  };
  const result = await analyzeBet(bet, {
    getPitcherGameLogFn: async () => [{ eventId: "evt-2", SO: 6 }],
  });
  assert.equal(result.legs[0].hit, null);
  assert.match(result.legs[0].note, /push/);
});

test("analyzeBet (vsTeamHistory) grades off H the same as hitStreak (regression for a real bug: this key was once missing entirely)", async () => {
  const bet = {
    sport: "mlb",
    legs: [
      {
        sport: "mlb",
        eventId: "evt-3",
        market: "vsTeamHistory",
        context: { kind: "trend", playerId: "p3", trendType: "vsTeamHistory", propSide: "Over", propPoint: 0.5 },
      },
    ],
  };
  const result = await analyzeBet(bet, {
    getBatterGameLogFn: async () => [{ eventId: "evt-3", H: 1 }],
  });
  assert.equal(result.legs[0].hit, true, "vsTeamHistory must grade off H, not come back unavailable");
});

test("analyzeBet finds the right game in a doubleheader by eventId, never falling back to date-matching when an eventId is present", async () => {
  const bet = {
    sport: "mlb",
    legs: [
      {
        sport: "mlb",
        eventId: "evt-game2",
        commenceTime: "2026-09-10T23:00:00Z",
        market: "hitStreak",
        context: { kind: "trend", playerId: "p1", trendType: "hitStreak", propSide: "Over", propPoint: 1.5 },
      },
    ],
  };
  const result = await analyzeBet(bet, {
    // Same calendar day, two games — only evt-game2 should ever be read.
    getBatterGameLogFn: async () => [
      { eventId: "evt-game1", date: "2026-09-10T18:00:00Z", H: 0 },
      { eventId: "evt-game2", date: "2026-09-10T23:00:00Z", H: 3 },
    ],
  });
  assert.equal(result.legs[0].hit, true, "must grade off game 2's own H, not fall back to game 1 just because it shares a calendar day");
});

test("analyzeBet returns hit:null when a real eventId isn't found in the log at all (never falls back to date-matching)", async () => {
  const bet = {
    sport: "mlb",
    legs: [
      {
        sport: "mlb",
        eventId: "evt-missing",
        commenceTime: "2026-09-10T23:00:00Z",
        market: "hitStreak",
        context: { kind: "trend", playerId: "p1", trendType: "hitStreak", propSide: "Over", propPoint: 1.5 },
      },
    ],
  };
  const result = await analyzeBet(bet, {
    getBatterGameLogFn: async () => [{ eventId: "evt-other", date: "2026-09-10T23:00:00Z", H: 5 }],
  });
  assert.equal(result.legs[0].hit, null, "an eventId that isn't in the log is a real gap, not a reason to guess off the same-day game");
});

test("analyzeBet handles an unknown sport gracefully", async () => {
  const bet = edgeBet({ sport: "cricket" });
  const result = await analyzeBet(bet);
  assert.equal(result.legs[0].hit, null);
  assert.match(result.legs[0].note, /Unknown sport/);
});
