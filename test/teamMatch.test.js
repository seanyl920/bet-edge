// First-ever test coverage for teamMatch.js. This file already documents
// two real, previously-shipped bugs in its own comments (doubleheader
// disambiguation by team name alone, and a single-candidate shortcut that
// skipped time validation entirely) — these tests exist to make sure
// neither regresses silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchEspnEvent } from "../server/teamMatch.js";

function espnEvent({ id, home, away, date }) {
  return { id, date, home: { name: home }, away: { name: away } };
}
function oddsEvent({ home_team, away_team, commence_time }) {
  return { home_team, away_team, commence_time };
}

test("matchEspnEvent matches on exact normalized team names", () => {
  const odds = oddsEvent({ home_team: "Kansas City Chiefs", away_team: "Denver Broncos", commence_time: "2026-09-10T17:00:00Z" });
  const espn = [espnEvent({ id: "e1", home: "Kansas City Chiefs", away: "Denver Broncos", date: "2026-09-10T17:00:00Z" })];
  assert.equal(matchEspnEvent(odds, espn)?.id, "e1");
});

test("matchEspnEvent normalization ignores case and punctuation", () => {
  const odds = oddsEvent({ home_team: "Kansas City Chiefs", away_team: "Denver Broncos", commence_time: "2026-09-10T17:00:00Z" });
  const espn = [espnEvent({ id: "e1", home: "kansas city chiefs!", away: "DENVER BRONCOS", date: "2026-09-10T17:00:00Z" })];
  assert.equal(matchEspnEvent(odds, espn)?.id, "e1");
});

test("matchEspnEvent disambiguates a doubleheader (same two teams, two ESPN events) by which one is closest in time", () => {
  const odds = oddsEvent({ home_team: "New York Mets", away_team: "Atlanta Braves", commence_time: "2026-09-10T23:10:00Z" });
  const espn = [
    espnEvent({ id: "game1", home: "New York Mets", away: "Atlanta Braves", date: "2026-09-10T17:10:00Z" }),
    espnEvent({ id: "game2", home: "New York Mets", away: "Atlanta Braves", date: "2026-09-10T23:05:00Z" }),
  ];
  assert.equal(matchEspnEvent(odds, espn)?.id, "game2", "must pick the game actually close in time, not just the first name match");
});

test("matchEspnEvent refuses to guess when two doubleheader candidates are both plausible (no clear winner)", () => {
  const odds = oddsEvent({ home_team: "New York Mets", away_team: "Atlanta Braves", commence_time: "2026-09-10T20:00:00Z" });
  const espn = [
    // Both roughly 2 hours from the odds event's time — genuinely ambiguous.
    espnEvent({ id: "game1", home: "New York Mets", away: "Atlanta Braves", date: "2026-09-10T18:05:00Z" }),
    espnEvent({ id: "game2", home: "New York Mets", away: "Atlanta Braves", date: "2026-09-10T21:55:00Z" }),
  ];
  assert.equal(matchEspnEvent(odds, espn), null, "must refuse to pick arbitrarily when neither candidate is clearly closer");
});

test("matchEspnEvent's single-candidate shortcut still rejects a game that's actually a different game (real time gap, e.g. game 1 already started and rolled off the list)", () => {
  // Confirmed real bug this guards against: with only ONE name-matching
  // ESPN event left (game 1 moved out of scheduled status), a lagging
  // odds quote for game 1 must not sail through onto game 2 just because
  // it's the only "candidate."
  const odds = oddsEvent({ home_team: "New York Mets", away_team: "Atlanta Braves", commence_time: "2026-09-10T17:10:00Z" }); // game 1's real time
  const espn = [espnEvent({ id: "game2", home: "New York Mets", away: "Atlanta Braves", date: "2026-09-10T23:05:00Z" })]; // only game 2 left
  assert.equal(matchEspnEvent(odds, espn), null, "a single candidate must still fail an absolute time sanity check, not be accepted unconditionally");
});

test("matchEspnEvent's single-candidate shortcut DOES accept a genuinely close single match", () => {
  const odds = oddsEvent({ home_team: "New York Mets", away_team: "Atlanta Braves", commence_time: "2026-09-10T23:00:00Z" });
  const espn = [espnEvent({ id: "game2", home: "New York Mets", away: "Atlanta Braves", date: "2026-09-10T23:05:00Z" })];
  assert.equal(matchEspnEvent(odds, espn)?.id, "game2");
});

test("matchEspnEvent falls back to a loose substring match on the same calendar day when no exact name match exists", () => {
  // Substring, not abbreviation-aware — "angels" must literally appear
  // inside (or contain) the other side's normalized name.
  const odds = oddsEvent({ home_team: "Angels", away_team: "Giants", commence_time: "2026-09-10T23:00:00Z" });
  const espn = [espnEvent({ id: "e1", home: "Los Angeles Angels", away: "San Francisco Giants", date: "2026-09-10T23:05:00Z" })];
  assert.equal(matchEspnEvent(odds, espn)?.id, "e1");
});

test("matchEspnEvent returns null when nothing matches at all", () => {
  const odds = oddsEvent({ home_team: "Team X", away_team: "Team Y", commence_time: "2026-09-10T23:00:00Z" });
  const espn = [espnEvent({ id: "e1", home: "Kansas City Chiefs", away: "Denver Broncos", date: "2026-09-10T23:00:00Z" })];
  assert.equal(matchEspnEvent(odds, espn), null);
});

test("matchEspnEvent returns null when the odds event has no commence_time to validate against", () => {
  const odds = oddsEvent({ home_team: "Kansas City Chiefs", away_team: "Denver Broncos", commence_time: null });
  const espn = [espnEvent({ id: "e1", home: "Kansas City Chiefs", away: "Denver Broncos", date: "2026-09-10T17:00:00Z" })];
  assert.equal(matchEspnEvent(odds, espn), null, "can't validate a time-based match without a real commence_time — must not guess");
});
