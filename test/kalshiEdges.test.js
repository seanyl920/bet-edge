// First-ever test coverage for kalshiEdges.js. Focuses on makeKalshiEdge()
// — the one genuinely new piece of business logic here (no devig, EV
// priced off Kalshi's real yes_ask, not a consensus best-price pick).
// getKalshiEdgeFeed()'s own orchestration (Elo bootstrap + ESPN scoreboard
// + Kalshi markets) isn't end-to-end tested here for the same reason
// edges.js's getEdgeFeed() isn't either — it needs a live network
// round-trip to exercise fully; the unsupported-sport early return below
// doesn't, so it's covered directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeKalshiEdge, getKalshiEdgeFeed } from "../server/kalshiEdges.js";

function fakeEvent(overrides = {}) {
  return {
    id: "evt1",
    date: "2026-09-15T03:15:00Z",
    home: { name: "Kansas City" },
    away: { name: "Denver" },
    ...overrides,
  };
}
function fakeSport(key = "nfl") {
  return { key, label: key.toUpperCase() };
}

test("makeKalshiEdge prices EV off the real yes_ask (askProb), not the mid used for blending", () => {
  const edge = makeKalshiEdge({
    event: fakeEvent(),
    sport: fakeSport(),
    side: "home",
    team: "Kansas City",
    ticker: "KXNFLGAME-26SEP14DENKC-KC",
    modelProb: 0.65,
    marketProb: 0.565, // the mid — used for blending against the model
    askProb: 0.57, // the real cost to buy Yes — used for decimalOdds/EV
    sampleSize: 20, // full trust weight, so blendedProb pulls hard toward modelProb
  });
  assert.equal(edge.book, "Kalshi");
  assert.equal(edge.market, "moneyline");
  assert.equal(edge.line, null);
  // decimalOdds must come from the ask (1/0.57), not the mid (1/0.565).
  assert.equal(edge.decimalOdds, Math.round((1 / 0.57) * 1000) / 1000);
  assert.ok(edge.ev != null, "a real edge with a real price must produce a real EV number");
});

test("makeKalshiEdge returns null decimalOdds/ev (never NaN or a fabricated number) when askProb is missing", () => {
  const edge = makeKalshiEdge({
    event: fakeEvent(),
    sport: fakeSport(),
    side: "home",
    team: "Kansas City",
    ticker: "t1",
    modelProb: 0.65,
    marketProb: 0.565,
    askProb: null,
    sampleSize: 20,
  });
  assert.equal(edge.decimalOdds, null);
  assert.equal(edge.ev, null);
  assert.equal(edge.americanOdds, null);
});

test("makeKalshiEdge's matchup reads 'away @ home' consistent with edges.js's own convention", () => {
  const edge = makeKalshiEdge({
    event: fakeEvent(),
    sport: fakeSport(),
    side: "away",
    team: "Denver",
    ticker: "t2",
    modelProb: 0.4,
    marketProb: 0.445,
    askProb: 0.45,
    sampleSize: 10,
  });
  assert.equal(edge.matchup, "Denver @ Kansas City");
  assert.equal(edge.side, "away");
  assert.equal(edge.team, "Denver");
});

test("getKalshiEdgeFeed returns available:false with a note for a sport with no confirmed Kalshi game series (no network touched)", async () => {
  const result = await getKalshiEdgeFeed({ key: "nhl", label: "NHL" });
  assert.equal(result.available, false);
  assert.equal(result.edges.length, 0);
  assert.ok(result.note?.includes("NHL"));
});
