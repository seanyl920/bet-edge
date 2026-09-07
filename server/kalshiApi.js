// Client for Kalshi's public market-data API (https://kalshi.com) — a
// CFTC-regulated event-contract exchange, not a traditional sportsbook.
//
// CONFIRMED against a live response (user ran the curl commands directly —
// this sandbox's network policy blocks kalshi.com, same restriction that
// applied to ESPN/The Odds API all session):
// - Base URL https://api.elections.kalshi.com/trade-api/v2 is real and
//   reachable with no API key for market-data reads.
// - /markets?series_ticker=X&status=open&limit=N returns
//   {cursor, markets: [...]}, exactly as this file already assumed.
// - Prices come back as DECIMAL-DOLLAR STRINGS, e.g. "yes_ask_dollars":
//   "0.3100" — NOT a bare 1-99 cents integer the way this file originally
//   guessed before checking. "0.3100" for a $1-notional contract IS the
//   probability directly (0.31), same idea as before, different field
//   name/format. Fixed below (dollarStringToProb, replacing the wrong
//   centsToImpliedProb).
// - Confirmed real, populated series: KXNFLSPREAD (e.g. event_ticker
//   "KXNFLSPREAD-26SEP14DENKC" for a Denver @ Kansas City game, individual
//   markets "KXNFLSPREAD-26SEP14DENKC-KC8"/"-KC7"/"-KC6" etc., one per
//   strike — "Kansas City wins by over 7.5/6.5/5.5 points?"). Kalshi's
//   spread isn't one two-sided market the way a sportsbook quotes -110/-110
//   at a single line — it's a LADDER of separate binary contracts, one per
//   threshold, each with its own yes/no price. KXWNBASPREAD/KXNHLSPREAD
//   confirmed to exist as real series too (empty of open markets at check
//   time, not tested for real games). Rate limiting is real on this public
//   endpoint (repeated "too_many_requests" errors hit scanning ~50 series
//   back-to-back) — surfaced below via a RATE_LIMITED error code so a
//   caller can treat it as "temporarily unavailable," not a hard failure.
//
// STILL UNVERIFIED, pending a live check: the moneyline-equivalent series
// name (a spread ladder's lowest strike, near 0, would function as one —
// not yet confirmed whether such a strike exists for a real game), the
// exact series naming for NBA/MLB (pattern suggests KXNBASPREAD/
// KXMLBSPREAD by analogy with KXNFLSPREAD/KXWNBASPREAD/KXNHLSPREAD, not
// confirmed live), and real MLB/NBA player-prop coverage. Nothing here
// should be trusted for real money until each of those is checked too —
// same rule this project has applied to every other data source.

import { cached } from "./cache.js";

const BASE = "https://api.elections.kalshi.com/trade-api/v2";
const FETCH_TIMEOUT_MS = 8000;
// Short TTL, no disk persistence — unlike The Odds API, there's no
// monthly-quota pressure here (confirmed: reading market data is free and
// unauthenticated), so this is purely "don't hammer the same page load
// twice," not quota preservation. Real rate limiting does exist though
// (confirmed live — see header) — this TTL also softens that.
const MARKETS_TTL_MS = 60 * 1000;

async function getJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 429) {
      const err = new Error(`Kalshi rate limit hit for ${url}`);
      err.code = "RATE_LIMITED";
      err.status = 429;
      throw err;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`Kalshi ${res.status} ${res.statusText} for ${url}: ${body}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    // Confirmed live: a rate-limited request can also come back 200 with
    // a JSON error body ({"error":{"code":"too_many_requests",...}})
    // rather than a real 429 status — this sandbox's own diagnostic run
    // saw both. Catch that shape too, same RATE_LIMITED code either way.
    if (data?.error?.code === "too_many_requests") {
      const err = new Error(`Kalshi rate limit hit for ${url}: ${data.error.message ?? ""}`);
      err.code = "RATE_LIMITED";
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Markets under a series (e.g. one sport/league's contracts), optionally
 * filtered by status ("open", "closed", "settled").
 * `seriesTicker` is Kalshi's own identifier for a market series — see this
 * file's header for which ones are actually confirmed live so far.
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

/** Events under a series — one event can group several related markets (e.g. a single game's spread-ladder contracts, one per strike). */
export async function getEvents({ seriesTicker, status = "open", limit = 200 } = {}) {
  const params = new URLSearchParams({ limit: String(limit), status });
  if (seriesTicker) params.set("series_ticker", seriesTicker);
  const key = `kalshi:events:${params.toString()}`;
  return cached(key, MARKETS_TTL_MS, async () => {
    const data = await getJson(`${BASE}/events?${params.toString()}`);
    return data?.events ?? [];
  });
}

/** Current order book (yes/no bids) for one specific market ticker. */
export async function getMarketOrderbook(ticker) {
  const key = `kalshi:orderbook:${ticker}`;
  return cached(key, MARKETS_TTL_MS, async () => {
    const data = await getJson(`${BASE}/markets/${encodeURIComponent(ticker)}/orderbook`);
    return data?.orderbook ?? null;
  });
}

/**
 * Kalshi's decimal-dollar price string (e.g. "0.3100", confirmed live —
 * see this file's header) -> a real probability. No vig-removal needed the
 * way a traditional sportsbook price does — Kalshi's own yes_bid/yes_ask
 * already bracket the market's actual clearing price directly, since
 * there's only one exchange price to read, not several books to devig
 * against. `yesAskDollars` is what you'd actually pay to buy Yes right now
 * (the real, actionable price for going long); `yesBidDollars` is what
 * you'd receive selling Yes (equivalently, buying No at 1 - yes_bid).
 */
export function dollarStringToProb(dollarStr) {
  if (dollarStr == null) return null;
  const n = Number(dollarStr);
  return Number.isFinite(n) ? n : null;
}
