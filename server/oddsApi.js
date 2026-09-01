// Client for The Odds API (https://the-odds-api.com) — a free-tier-friendly
// aggregator of real sportsbook lines across many US/UK/EU books. Free tier
// is ~500 requests/month, so every call here is cached and the caller
// should prefer the cached edge-feed route over hitting this directly.

import { cached } from "./cache.js";

const BASE = "https://api.the-odds-api.com/v4";
const FETCH_TIMEOUT_MS = 8000;
const ODDS_TTL_MS = 5 * 60 * 1000; // 5 min — balances freshness against the free-tier quota

export function hasOddsApiKey() {
  return Boolean(process.env.ODDS_API_KEY);
}

async function getJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const remaining = res.headers.get("x-requests-remaining");
    const used = res.headers.get("x-requests-used");
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`Odds API ${res.status} ${res.statusText}: ${body}`);
      err.status = res.status;
      throw err;
    }
    return { data: await res.json(), quota: { remaining, used } };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Odds for every upcoming event in a sport, across books.
 * markets: comma-separated, e.g. "h2h,spreads,totals"
 */
export async function getOdds(sport, { markets = "h2h,spreads,totals", regions = "us" } = {}) {
  if (!hasOddsApiKey()) {
    const err = new Error("ODDS_API_KEY not configured");
    err.code = "NO_ODDS_KEY";
    throw err;
  }
  const key = `oddsapi:${sport.oddsApiKey}:${markets}:${regions}`;
  return cached(key, ODDS_TTL_MS, async () => {
    const url =
      `${BASE}/sports/${sport.oddsApiKey}/odds/?apiKey=${process.env.ODDS_API_KEY}` +
      `&regions=${regions}&markets=${markets}&oddsFormat=american&dateFormat=iso`;
    const { data, quota } = await getJson(url);
    return { events: data, quota };
  });
}

/**
 * Player-prop odds for one event. This is a separate, per-event endpoint on
 * The Odds API (player props aren't included in the bulk /odds call) and
 * costs credits per call — only ever call this on-demand from a user click
 * ("check odds" on a trend card), never in an automatic poll/refresh loop.
 * Cached briefly just to survive an accidental double-click.
 */
export async function getPlayerProps(sport, oddsEventId, markets) {
  if (!hasOddsApiKey()) {
    const err = new Error("ODDS_API_KEY not configured");
    err.code = "NO_ODDS_KEY";
    throw err;
  }
  const key = `oddsapi:props:${sport.oddsApiKey}:${oddsEventId}:${markets}`;
  return cached(key, 10 * 60 * 1000, async () => {
    const url =
      `${BASE}/sports/${sport.oddsApiKey}/events/${oddsEventId}/odds?apiKey=${process.env.ODDS_API_KEY}` +
      `&regions=us&markets=${markets}&oddsFormat=american&dateFormat=iso`;
    const { data, quota } = await getJson(url);
    return { event: data, quota };
  });
}

/**
 * Historical/closing snapshot for one event, used for CLV capture.
 * The Odds API's historical endpoint costs extra credits and requires a
 * paid plan on some tiers — this call is only made on-demand (never polled)
 * when the user explicitly asks to capture a closing line.
 */
export async function getEventOddsSnapshot(sport, eventId, { markets = "h2h" } = {}) {
  if (!hasOddsApiKey()) {
    const err = new Error("ODDS_API_KEY not configured");
    err.code = "NO_ODDS_KEY";
    throw err;
  }
  const url =
    `${BASE}/sports/${sport.oddsApiKey}/events/${eventId}/odds?apiKey=${process.env.ODDS_API_KEY}` +
    `&regions=us&markets=${markets}&oddsFormat=american&dateFormat=iso`;
  const { data, quota } = await getJson(url);
  return { event: data, quota };
}
