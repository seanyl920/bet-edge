// Client for The Odds API (https://the-odds-api.com) — a free-tier-friendly
// aggregator of real sportsbook lines across many US/UK/EU books. Free tier
// is ~500 requests/month, so every call here is cached and the caller
// should prefer the cached edge-feed route over hitting this directly.

import { cached } from "./cache.js";

const BASE = "https://api.the-odds-api.com/v4";
const FETCH_TIMEOUT_MS = 8000;
// Confirmed real problem: a user hit their monthly quota. 5 min was tuned
// for catching live line movement, which this personal research tool was
// never actually trying to do (see README's Honesty & limits — this isn't
// a live trading terminal). Bumped to 30 min: still plenty fresh for
// spotting a value bet hours or days before kickoff, and cuts refetch
// frequency 6x. Combined with cache.js's new disk persistence (see
// getOdds/getPlayerProps below), a stopped-and-restarted dev server no
// longer forces a fresh, quota-costing re-fetch the moment the page loads.
const ODDS_TTL_MS = 30 * 60 * 1000;
const PLAYER_PROPS_TTL_MS = 30 * 60 * 1000; // was 10 min — same reasoning

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
  return cached(
    key,
    ODDS_TTL_MS,
    async () => {
      const url =
        `${BASE}/sports/${sport.oddsApiKey}/odds/?apiKey=${process.env.ODDS_API_KEY}` +
        `&regions=${regions}&markets=${markets}&oddsFormat=american&dateFormat=iso`;
      const { data, quota } = await getJson(url);
      return { events: data, quota };
    },
    // Survives a dev-server restart — see ODDS_TTL_MS's comment above.
    { persist: true }
  );
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
  return cached(
    key,
    PLAYER_PROPS_TTL_MS,
    async () => {
      const url =
        `${BASE}/sports/${sport.oddsApiKey}/events/${oddsEventId}/odds?apiKey=${process.env.ODDS_API_KEY}` +
        `&regions=us&markets=${markets}&oddsFormat=american&dateFormat=iso`;
      const { data, quota } = await getJson(url);
      return { event: data, quota };
    },
    // A per-event, credit-costing call — surviving a restart matters even
    // more here than for the bulk odds above.
    { persist: true }
  );
}
