// First real test coverage for parlay.js's combineLegs — previously
// validated only by ad hoc manual checks (see README's Known-issue
// history). Covers the two bugs confirmed by external review (Sept 2026):
// duplicate legs treated as independent, and books silently mixed with no
// warning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { combineLegs } from "../server/parlay.js";

function leg(overrides = {}) {
  return {
    eventId: "evt-1",
    market: "moneyline",
    selection: "Home",
    label: "Home ML",
    americanOdds: -150,
    trueProb: 0.6,
    book: "DraftKings",
    ...overrides,
  };
}

test("combineLegs rejects an exact duplicate leg (same eventId/market/selection) instead of pricing it as independent", () => {
  // Confirmed real bug: 10 copies of one -150 pick were reported as a
  // combined +16438 at 0% EV — no sportsbook treats a bet against itself
  // as independent legs.
  assert.throws(
    () => combineLegs([leg(), leg()]),
    (err) => err.status === 400 && /duplicate/i.test(err.message)
  );
});

test("combineLegs rejects duplicates regardless of price/book differences — same real bet either way", () => {
  assert.throws(
    () => combineLegs([leg({ book: "DraftKings", americanOdds: -150 }), leg({ book: "FanDuel", americanOdds: -140 })]),
    (err) => err.status === 400 && /duplicate/i.test(err.message)
  );
});

test("combineLegs does NOT reject two different legs on the same event (different market/selection)", () => {
  const result = combineLegs([leg({ market: "moneyline", selection: "Home" }), leg({ market: "spread", selection: "Home -3.5", eventId: "evt-1" })]);
  assert.ok(result.naive.trueProb > 0);
});

test("combineLegs warns when legs are priced across more than one book", () => {
  const result = combineLegs([
    leg({ eventId: "evt-1", market: "moneyline", selection: "Home", book: "DraftKings" }),
    leg({ eventId: "evt-2", market: "moneyline", selection: "Away", book: "FanDuel" }),
  ]);
  assert.ok(
    result.correlationWarnings.some((w) => /different books/i.test(w) && w.includes("DraftKings") && w.includes("FanDuel")),
    "expected a mixed-book warning naming both books"
  );
});

test("combineLegs does NOT warn when every leg is from the same book", () => {
  const result = combineLegs([
    leg({ eventId: "evt-1", market: "moneyline", selection: "Home", book: "DraftKings" }),
    leg({ eventId: "evt-2", market: "moneyline", selection: "Away", book: "DraftKings" }),
  ]);
  assert.ok(!result.correlationWarnings.some((w) => /different books/i.test(w)));
});

test("combineLegs does NOT warn about mixed books when book is missing (an older bet, pre-dating book-tracking)", () => {
  const result = combineLegs([
    leg({ eventId: "evt-1", market: "moneyline", selection: "Home", book: undefined }),
    leg({ eventId: "evt-2", market: "moneyline", selection: "Away", book: undefined }),
  ]);
  assert.ok(!result.correlationWarnings.some((w) => /different books/i.test(w)), "missing book data must never be treated as a mismatch against itself");
});

test("combineLegs still computes the exact same-team moneyline+spread adjustment (existing behavior, unaffected by this round's fixes)", () => {
  const result = combineLegs([
    leg({ eventId: "evt-1", market: "moneyline", selection: "Home", trueProb: 0.6, context: { team: "Home" } }),
    leg({ eventId: "evt-1", market: "spread", selection: "Home -3.5", trueProb: 0.55, context: { team: "Home" } }),
  ]);
  assert.ok(result.correlationAdjusted, "expected the exact adjustment to fire for a same-team ML+spread pair");
  assert.equal(result.correlationAdjusted.trueProb, 0.55); // min(0.6, 0.55)
});
