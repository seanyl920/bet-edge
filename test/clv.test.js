// First-ever test coverage for clv.js. Written alongside two confirmed
// real bugs found by code review (no external review this round — a
// self-audit): (1) the trend-leg branch reported EVERY unmatched-event
// miss as "ODDS_API_KEY not configured," the same confusion already fixed
// elsewhere (trends.js/TrendFeed.jsx/dailyParlay.js) but never applied
// here; (2) the edge-leg branch never checked hasOddsApiKey() at all
// before calling getGameOddsTable(), so a missing key surfaced as a raw
// 500 instead of a clear 400.
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureClosingPrice } from "../server/clv.js";

function trendBet(overrides = {}) {
  return {
    sport: "mlb",
    legs: [
      {
        sport: "mlb",
        eventId: "evt-1",
        market: "hitStreak",
        context: { kind: "trend", playerName: "Test Player", trendType: "hitStreak", propSide: "Over", propPoint: 1.5 },
        ...overrides,
      },
    ],
  };
}

function edgeBet(overrides = {}) {
  return {
    sport: "nfl",
    legs: [
      {
        sport: "nfl",
        eventId: "evt-2",
        market: "moneyline",
        context: { kind: "edge", side: "home", line: null },
        ...overrides,
      },
    ],
  };
}

test("captureClosingPrice rejects a multi-leg (parlay) bet — no single clean closing price", async () => {
  const bet = { sport: "mlb", legs: [trendBet().legs[0], trendBet().legs[0]] };
  await assert.rejects(() => captureClosingPrice(bet), (err) => err.status === 400 && /single-leg/i.test(err.message));
});

test("captureClosingPrice (trend leg) reports the real reason for an unmatched event — not a false 'no key' claim", async () => {
  // Confirmed real bug: this used to say "ODDS_API_KEY not configured"
  // here even with a real key, just because this one game's props hadn't
  // matched an odds event yet — a normal, common outcome.
  const bet = trendBet();
  await assert.rejects(
    () =>
      captureClosingPrice(bet, {
        getTrendPropOddsFn: async () => ({ available: false, reason: "event-not-found", outcomes: [] }),
      }),
    (err) => err.status === 400 && /No matching odds event/i.test(err.message) && !/ODDS_API_KEY/.test(err.message)
  );
});

test("captureClosingPrice (trend leg) reports the real 'no key' case distinctly", async () => {
  const bet = trendBet();
  await assert.rejects(
    () =>
      captureClosingPrice(bet, {
        getTrendPropOddsFn: async () => ({ available: false, reason: "no-key", outcomes: [] }),
      }),
    (err) => err.status === 400 && /ODDS_API_KEY not configured/.test(err.message)
  );
});

test("captureClosingPrice (trend leg) picks the best (highest-decimal) matching price", async () => {
  const bet = trendBet();
  const price = await captureClosingPrice(bet, {
    getTrendPropOddsFn: async () => ({
      available: true,
      outcomes: [
        { side: "Over", point: 1.5, price: -130, book: "A" },
        { side: "Over", point: 1.5, price: 120, book: "B" }, // better price for the bettor
        { side: "Over", point: 2.5, price: 500, book: "C" }, // different point — must not match
        { side: "Under", point: 1.5, price: 300, book: "D" }, // different side — must not match
      ],
    }),
  });
  assert.equal(price, 120);
});

test("captureClosingPrice (trend leg) 404s when nothing matches this exact side/point", async () => {
  const bet = trendBet();
  await assert.rejects(
    () => captureClosingPrice(bet, { getTrendPropOddsFn: async () => ({ available: true, outcomes: [] }) }),
    (err) => err.status === 404
  );
});

test("captureClosingPrice (edge leg) 400s immediately with a clear message when no key is configured — not a raw 500", async () => {
  // Confirmed real bug: this branch never checked hasOddsApiKey() at all,
  // so a missing key would have let getGameOddsTableFn's real
  // implementation throw an uncoded error the global handler defaults to
  // a 500 for — reproduced here via a stub that would throw if called,
  // proving the check short-circuits before ever reaching it.
  const bet = edgeBet();
  await assert.rejects(
    () =>
      captureClosingPrice(bet, {
        hasOddsApiKeyFn: () => false,
        getGameOddsTableFn: async () => {
          throw new Error("must not be called when no key is configured");
        },
      }),
    (err) => err.status === 400 && /ODDS_API_KEY not configured/.test(err.message)
  );
});

test("captureClosingPrice (edge leg) picks the best price for the correct team/side, ignoring other teams/lines", async () => {
  const bet = edgeBet();
  const price = await captureClosingPrice(bet, {
    hasOddsApiKeyFn: () => true,
    getGameOddsTableFn: async () => ({
      homeTeam: "Home Team",
      awayTeam: "Away Team",
      books: [
        { markets: { h2h: [{ name: "Home Team", price: -150 }, { name: "Away Team", price: 130 }] } },
        { markets: { h2h: [{ name: "Home Team", price: -140 }] } }, // better price for the home side
      ],
    }),
  });
  assert.equal(price, -140);
});

test("captureClosingPrice (edge leg, spread) requires the point to match, not just the team", async () => {
  const bet = edgeBet({ market: "spread", context: { kind: "edge", side: "home", line: -3.5 } });
  const price = await captureClosingPrice(bet, {
    hasOddsApiKeyFn: () => true,
    getGameOddsTableFn: async () => ({
      homeTeam: "Home Team",
      awayTeam: "Away Team",
      books: [
        { markets: { spreads: [{ name: "Home Team", point: -3, price: -110 }, { name: "Home Team", point: -3.5, price: -105 }] } },
      ],
    }),
  });
  assert.equal(price, -105, "must match the exact -3.5 line this bet was placed at, not a nearby -3");
});

test("captureClosingPrice (edge leg) 404s when the game odds table can't be found at all", async () => {
  const bet = edgeBet();
  await assert.rejects(
    () => captureClosingPrice(bet, { hasOddsApiKeyFn: () => true, getGameOddsTableFn: async () => null }),
    (err) => err.status === 404
  );
});

test("captureClosingPrice rejects an older bet leg missing the snapshot fields this feature needs", async () => {
  const trendMissing = trendBet({ context: { kind: "trend" } }); // no playerName/trendType/propSide
  await assert.rejects(() => captureClosingPrice(trendMissing), (err) => err.status === 400 && /Missing player\/prop snapshot/.test(err.message));

  const edgeMissing = edgeBet({ context: { kind: "edge" } }); // no side
  await assert.rejects(() => captureClosingPrice(edgeMissing), (err) => err.status === 400 && /Missing side\/market snapshot/.test(err.message));
});
