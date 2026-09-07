// Client for Kalshi's public market-data API (https://kalshi.com) — a
// CFTC-regulated event-contract exchange, not a traditional sportsbook.
// Confirmed via Kalshi's own docs and multiple independent developer
// guides (this sandbox's network policy blocks kalshi.com's own domains
// directly, the same restriction that applied to ESPN/The Odds API all
// session — see README's Known-issue history): reading market data
// (events, markets, order books) needs NO API key and has NO monthly
// quota, unlike The Odds API this app used before. Only PLACING an order
// needs the authenticated (RSA-signed) side of the API — this app never
// does that; it's a research/logging tool, not an auto-trader, and orders
// are still placed by hand on Kalshi's own site/app.
//
// UNVERIFIED, pending a live check (this sandbox cannot reach kalshi.com
// — see above): the exact series_ticker naming convention for NFL/NBA/MLB
// game markets, whether a spread-equivalent contract exists for every
// game, and real MLB player-prop coverage. Confirmed from documentation
// and independent write-ups, not a live response: the base URL, the
// /markets and /events endpoints' query params, and the yes_bid/yes_ask/
// no_bid/no_ask (cents, 1-99, direct implied-probability) response shape.
// Nothing here should be trusted for real money until a live response is
// checked — same rule this project has applied to every other data source.

import { cached } from "./cache.js";

const BASE = "https://api.elections.kalshi.com/trade-api/v2";
const FETCH_TIMEOUT_MS = 8000;
// Short TTL, no disk persistence — unlike The Odds API, there's no
// monthly-quota pressure here (confirmed: reading market data is free and
// unauthenticated), so this is purely "don't hammer the same page load
// twice," not quota preservation.
const MARKETS_TTL_MS = 60 * 1000;

async function getJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`Kalshi ${res.status} ${res.statusText} for ${url}: ${body}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Markets under a series (e.g. one sport/league's contracts), optionally
 * filtered by status ("open", "closed", "settled").
 * `seriesTicker` is Kalshi's own identifier for a market series — see this
 * file's header: the real values for NFL/NBA/MLB are UNVERIFIED pending a
 * live check, not guessed here.
 */
export async function getMarkets({ seriesTicker, status = "open", limit = 200 } = {}) {
  const params = new URLSearchParams({ limit: String(limit), status });
  if (seriesTicker) params.set("series_ticker", seriesTicker);
  const key = `kalshi:markets:${params.toString()}`;
  return cached(key, MARKETS_TTL_MS, async () => {
    const data = await getJson(`${BASE}/markets?${params.toString()}`);
    return data?.markets ?? [];
  });
}

/** Events under a series — one event can group several related markets (e.g. a single game's moneyline + spread-equivalent contracts). */
export async function getEvents({ seriesTicker, status = "open", limit = 200 } = {}) {
  const params = new URLSearchParams({ limit: String(limit), status });
  if (seriesTicker) params.set("series_ticker", seriesTicker);
  const key = `kalshi:events:${params.toString()}`;
  return cached(key, MARKETS_TTL_MS, async () => {
    const data = await getJson(`${BASE}/events?${params.toString()}`);
    return data?.events ?? [];
  });
}

/** Current order book (yes/no bids, cents) for one specific market ticker. */
export async function getMarketOrderbook(ticker) {
  const key = `kalshi:orderbook:${ticker}`;
  return cached(key, MARKETS_TTL_MS, async () => {
    const data = await getJson(`${BASE}/markets/${encodeURIComponent(ticker)}/orderbook`);
    return data?.orderbook ?? null;
  });
}

/**
 * Cents (1-99) -> a real probability, no vig-removal needed the way a
 * traditional sportsbook price does — Kalshi's own yes_bid/yes_ask already
 * bracket the market's actual clearing price directly. `yes_ask` is what
 * you'd actually pay to buy Yes right now (the real, actionable price);
 * `yes_bid` is what you'd receive selling Yes (equivalently, buying No at
 * 100 - yes_bid). Mid-price (bid+ask)/2 is the closest thing to a "fair"
 * probability estimate this single-exchange model has — there's no second
 * book to devig against the way edges.js's consensusAndBest needs one.
 */
export function centsToImpliedProb(cents) {
  if (cents == null || !Number.isFinite(cents)) return null;
  return cents / 100;
}
