// First-ever test coverage for streaks.js — pure streak/rate math shared
// across every batter/pitcher trend this app builds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { consecutiveStreak, countInLastN, vsTeamSplit } from "../server/streaks.js";

test("consecutiveStreak counts from the most recent game and stops at the first miss", () => {
  const games = [{ H: 1 }, { H: 1 }, { H: 1 }, { H: 0 }, { H: 1 }];
  assert.equal(consecutiveStreak(games, (g) => g.H >= 1), 3);
});

test("consecutiveStreak is 0 when the very first (most recent) game already misses", () => {
  const games = [{ H: 0 }, { H: 1 }, { H: 1 }];
  assert.equal(consecutiveStreak(games, (g) => g.H >= 1), 0);
});

test("consecutiveStreak counts every game when the whole log satisfies the predicate", () => {
  const games = [{ H: 1 }, { H: 2 }, { H: 3 }];
  assert.equal(consecutiveStreak(games, (g) => g.H >= 1), 3);
});

test("consecutiveStreak on an empty log is 0", () => {
  assert.equal(consecutiveStreak([], () => true), 0);
});

test("countInLastN counts non-consecutive hits within a window, not requiring a streak", () => {
  const games = [{ HR: 1 }, { HR: 0 }, { HR: 1 }, { HR: 0 }, { HR: 1 }, { HR: 1 }];
  assert.equal(countInLastN(games, 5, (g) => g.HR >= 1), 3, "3 of the first 5 games have an HR, regardless of order");
});

test("countInLastN never looks past the requested window even if the log is longer", () => {
  const games = [{ HR: 0 }, { HR: 0 }, { HR: 0 }, { HR: 1 }]; // the 1 is outside a window of 3
  assert.equal(countInLastN(games, 3, (g) => g.HR >= 1), 0);
});

test("vsTeamSplit aggregates only games against the specified opponent", () => {
  const games = [
    { opponentTeamId: "T1", AB: 4, H: 2, HR: 1 },
    { opponentTeamId: "T2", AB: 3, H: 1, HR: 0 },
    { opponentTeamId: "T1", AB: 5, H: 1, HR: 0 },
  ];
  const split = vsTeamSplit(games, "T1");
  assert.equal(split.games, 2);
  assert.equal(split.AB, 9);
  assert.equal(split.H, 3);
  assert.equal(split.HR, 1);
  assert.ok(Math.abs(split.avg - 3 / 9) < 1e-9);
});

test("vsTeamSplit returns avg:null (not a divide-by-zero NaN or 0) when there are no at-bats against this opponent", () => {
  const split = vsTeamSplit([{ opponentTeamId: "T2", AB: 3, H: 1 }], "T1");
  assert.equal(split.games, 0);
  assert.equal(split.AB, 0);
  assert.equal(split.avg, null);
});

test("vsTeamSplit excludes a game with no recorded AB entirely, rather than treating it as a real 0-AB game", () => {
  const games = [
    { opponentTeamId: "T1", AB: null, H: 0 },
    { opponentTeamId: "T1", AB: 4, H: 2 },
  ];
  const split = vsTeamSplit(games, "T1");
  assert.equal(split.games, 1, "the AB:null game must not count toward the games total either");
});
