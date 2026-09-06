// First-ever test coverage for dateUtil.js — the local-calendar-day helper
// this app has already been bitten by twice (daily-parlay rollover,
// postmortem grading stuck on "not final yet" for evening games — see
// README's Known-issue history). These pin down the actual timezone-
// boundary behavior that matters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { localDateKey } from "../server/dateUtil.js";

test("localDateKey returns YYYY-MM-DD format", () => {
  const key = localDateKey("2026-09-10T17:00:00Z");
  assert.match(key, /^\d{4}-\d{2}-\d{2}$/);
});

test("localDateKey converts a late-UTC evening timestamp to the correct US Eastern calendar day", () => {
  // 2026-09-11T02:30:00Z is 2026-09-10 10:30pm Eastern (EDT, UTC-4) — a
  // real, common case: a West Coast night game's late innings. Naive
  // UTC slicing would wrongly say "2026-09-11".
  const key = localDateKey("2026-09-11T02:30:00Z");
  assert.equal(key, "2026-09-10");
});

test("localDateKey handles a timestamp early in the UTC day that's still the previous US Eastern day", () => {
  // 2026-09-10T03:00:00Z is 2026-09-09 11:00pm Eastern.
  const key = localDateKey("2026-09-10T03:00:00Z");
  assert.equal(key, "2026-09-09");
});

test("localDateKey accepts a Date object as well as a string", () => {
  const d = new Date("2026-09-10T17:00:00Z");
  assert.equal(localDateKey(d), localDateKey("2026-09-10T17:00:00Z"));
});

test("localDateKey returns null for an unparseable input, never a guess", () => {
  assert.equal(localDateKey("not a real date"), null);
});

test("localDateKey supports an explicit timezone override", () => {
  // Same instant, different timezones must be allowed to disagree on the
  // calendar day — that's the entire point of this function existing.
  const utcKey = localDateKey("2026-09-10T02:00:00Z", "UTC");
  const easternKey = localDateKey("2026-09-10T02:00:00Z", "America/New_York");
  assert.equal(utcKey, "2026-09-10");
  assert.equal(easternKey, "2026-09-09");
});

test("localDateKey defaults to 'now' when called with no argument", () => {
  const key = localDateKey();
  assert.match(key, /^\d{4}-\d{2}-\d{2}$/);
});
