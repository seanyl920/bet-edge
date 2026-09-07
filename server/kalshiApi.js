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
//   threshold, each with its own yes/no price. The full DEN@KC ladder was
//   pulled live and its LOWEST strike is 1.5 (both "...-KC2"/floor 1.5 and
//   the DEN mirror) — there is no near-zero strike in this ladder, so a
//   spread contract alone can't stand in for a moneyline; a game decided
//   by exactly 1 point isn't resolved "yes" by any contract here. That
//   overturns this file's earlier working guess (see git history).
// - KXMLBSPREAD confirmed real and populated too, same ladder shape —
//   e.g. event_tickers "KXMLBSPREAD-26SEP061820MINCWS" (Minnesota @
//   Chicago White Sox) and "KXMLBSPREAD-26SEP072110CINLAD" (Cincinnati @
//   LA Dodgers). So the KX<LEAGUE>SPREAD naming convention generalizes
//   across at least NFL and MLB. KXNBASPREAD confirmed to exist as a real
//   series name too, but had zero open markets at check time (most likely
//   just an NBA-offseason/no-games-scheduled gap, not a naming miss —
//   not yet re-checked once games are live). KXWNBASPREAD/KXNHLSPREAD
//   also confirmed to exist as real series (also empty of open markets at
//   check time).
// - Rate limiting is real on this public endpoint (repeated
//   "too_many_requests" errors hit scanning ~50 series back-to-back) —
//   surfaced below via a RATE_LIMITED error code so a caller can treat it
//   as "temporarily unavailable," not a hard failure.
//
// - CONFIRMED live: the actual moneyline lives in its own series,
//   KXNFLGAME, wholly separate from KXNFLSPREAD. Same event_ticker as the
//   matching spread event (e.g. "KXNFLGAME-26SEP14DENKC", "KXNFLSPREAD-
//   26SEP14DENKC" — both key off the same "<YYMONDD><AWAY><HOME>" game
//   identity), but its market tickers carry no numeric strike suffix —
//   just the team abbreviation directly (e.g. "KXNFLGAME-26SEP14DENKC-KC"
//   / "...-DEN", `strike_type: "structured"`, no floor_strike field). One
//   Yes/No contract per team, Yes backing that team winning outright —
//   yes_ask_dollars/yes_bid_dollars on that contract IS the moneyline
//   implied probability directly. This is the real moneyline-equivalent
//   this file was missing; the spread ladder is a separate product for
//   over/under-the-line questions, not a substitute for it.
//
// - CONFIRMED live: KXMLBGAME and KXNBAGAME are real too, same shape as
//   KXNFLGAME (team-abbreviation ticker suffix, strike_type "structured",
//   no floor_strike, one Yes/No contract per team). So "KX<LEAGUE>GAME"
//   for moneyline / "KX<LEAGUE>SPREAD" for the strike ladder is a real,
//   general convention across NFL/MLB/NBA, not just an NFL quirk.
//   KXMLBGAME's event_ticker embeds a start-time (e.g.
//   "KXMLBGAME-26SEP091940PITCWS", matching KXMLBSPREAD's own dated-event
//   format) — needed since the same two MLB teams can play more than once
//   in a day (doubleheaders); KXNFLGAME/KXNBAGAME's event_ticker is
//   date-only (e.g. "KXNBAGAME-26OCT20OKCSAS"), matching one game per
//   matchup per day for those sports.
//
// STILL UNVERIFIED: real MLB/NBA player-prop coverage (NFL prop coverage
// was seen in passing during the broader diagnostic scan — TD props,
// MVP/award markets — but not checked for MLB/NBA specifically). Nothing
// here should be trusted for real money until that's checked too — same
// rule this project has applied to every other data source.

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

function midProb(bidDollars, askDollars) {
  const bid = dollarStringToProb(bidDollars);
  const ask = dollarStringToProb(askDollars);
  if (bid == null && ask == null) return null;
  if (bid == null) return ask;
  if (ask == null) return bid;
  return (bid + ask) / 2;
}

/**
 * Groups a flat KX<LEAGUE>GAME markets array (confirmed live for
 * KXNFLGAME/KXMLBGAME/KXNBAGAME — one market row per team, two rows per
 * game) by event_ticker into one entry per game with both teams' prices
 * alongside each other, ready for matching against an ESPN scoreboard.
 *
 * Each team's `prob` is the mid of yes_bid/yes_ask — a steadier estimate
 * of the market's actual fair view, for comparing against a model.
 * `askProb` is yes_ask alone: the real, actionable cost to buy Yes on
 * that team right now, which is what an actual EV/Kelly calculation has
 * to price off of (the mid isn't a price you can actually transact at).
 * `name` is Kalshi's own shorthand for
 * that side (yes_sub_title) — confirmed to disambiguate multi-team
 * cities with a trailing letter (e.g. "Los Angeles C" for the Chargers
 * vs "Los Angeles R" for the Rams, "New York G" vs "New York J"), not a
 * full franchise name — so matching this against ESPN's team names needs
 * its own lookup, not the loose substring match teamMatch.js uses for
 * The Odds API's full team names. `gameTime` is occurrence_datetime, the
 * actual scheduled kickoff/first-pitch — confirmed distinct from (and
 * earlier than) close_time/expiration_time, which pad in a settlement
 * buffer after the game ends.
 */
export function groupGameWinnerMarkets(markets) {
  const byEvent = new Map();
  for (const m of markets ?? []) {
    if (!m?.event_ticker) continue;
    if (!byEvent.has(m.event_ticker)) {
      byEvent.set(m.event_ticker, {
        eventTicker: m.event_ticker,
        gameTime: m.occurrence_datetime ?? null,
        teams: [],
      });
    }
    byEvent.get(m.event_ticker).teams.push({
      ticker: m.ticker ?? null,
      name: m.yes_sub_title ?? null,
      prob: midProb(m.yes_bid_dollars, m.yes_ask_dollars),
      askProb: dollarStringToProb(m.yes_ask_dollars),
    });
  }
  return Array.from(byEvent.values());
}
