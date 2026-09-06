// Captures an approximation of "the closing line" for one single-leg bet:
// the current best price across books for that exact selection, fetched
// on-demand (never automatically — same rule as every other odds call in
// this app that isn't the bulk edge-feed fetch). This is a real
// approximation, not textbook CLV: proper closing-line value compares your
// price to the SAME BOOK's closing price, but a bet's leg snapshot never
// recorded which book it was placed at (see EdgeFeed.jsx/TrendFeed.jsx —
// no `book` field), so "current best price across books, called close to
// first pitch" is what's actually captured. Call it a few minutes before
// first pitch — once a game goes live, in-play pricing takes over and this
// stops meaning "closing line."

import { requireSport } from "./sports.js";
import { getGameOddsTable } from "./edges.js";
import { getTrendPropOdds } from "./trends.js";
import { americanToDecimal } from "./oddsMath.js";
import { hasOddsApiKey } from "./oddsApi.js";

function bestPriceFromTable(table, market, side, line) {
  const teamName = side === "home" ? table.homeTeam : table.awayTeam;
  const marketKey = market === "spread" ? "spreads" : "h2h";
  let best = null;
  for (const b of table.books ?? []) {
    const outcomes = b.markets?.[marketKey] ?? [];
    const match = outcomes.find((o) => o.name === teamName && (market !== "spread" || o.point === line));
    if (!match) continue;
    const decimal = americanToDecimal(match.price);
    if (decimal != null && (!best || decimal > best.decimal)) best = { american: match.price, decimal };
  }
  return best;
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}

/**
 * Approximate current closing price for one bet's single leg (American
 * odds). `getGameOddsTableFn`/`getTrendPropOddsFn`/`hasOddsApiKeyFn`
 * default to the real edges.js/trends.js/oddsApi.js functions — overridable
 * so tests can exercise this module's own branching/validation logic with
 * stubs instead of live network access.
 */
export async function captureClosingPrice(
  bet,
  { getGameOddsTableFn = getGameOddsTable, getTrendPropOddsFn = getTrendPropOdds, hasOddsApiKeyFn = hasOddsApiKey } = {}
) {
  const legs = Array.isArray(bet.legs) && bet.legs.length ? bet.legs : [bet];
  if (legs.length > 1) {
    throw badRequest("Closing-line capture only supports single-leg bets — a parlay doesn't have one clean closing price the way a straight bet does.");
  }
  const [leg] = legs;
  const ctx = leg.context ?? {};
  const sport = requireSport(leg.sport ?? bet.sport);

  if (ctx.kind === "trend") {
    if (!ctx.playerName || !ctx.trendType || !ctx.propSide) {
      throw badRequest("Missing player/prop snapshot for this leg — can't capture a closing price (likely an older bet logged before this feature).");
    }
    // Confirmed real bug: `available: false` from getTrendPropOdds() means
    // "couldn't match this one event to an odds event" FAR more often than
    // it means "no API key" (see trends.js's own comment on this exact
    // confusion, already fixed in TrendFeed.jsx/dailyParlay.js) — this
    // caller never got that fix and was still reporting every miss as
    // "ODDS_API_KEY not configured," which is simply false for the common
    // case (a real key, a game whose props just haven't posted odds).
    // Check `reason` the same way those other callers do.
    const { available, reason, outcomes } = await getTrendPropOddsFn(sport, leg.eventId, ctx.playerName, ctx.trendType);
    if (!available) {
      throw badRequest(
        reason === "no-key"
          ? "ODDS_API_KEY not configured."
          : "No matching odds event found for this game — the market may not have posted odds yet, or has already closed."
      );
    }
    const matches = outcomes.filter((o) => o.side === ctx.propSide && o.point === ctx.propPoint);
    const best = matches.reduce((b, o) => (!b || americanToDecimal(o.price) > americanToDecimal(b.price) ? o : b), null);
    if (!best) throw notFound("No current price found for this prop — the market may have closed, or the line moved off this point.");
    return best.price;
  }

  // Edge leg: moneyline or spread.
  if (!leg.eventId || !ctx.side || !leg.market) {
    throw badRequest("Missing side/market snapshot for this leg — can't capture a closing price (likely an older bet logged before this feature).");
  }
  // Confirmed real bug: unlike the trend-leg branch above, this never
  // checked hasOddsApiKey() before calling getGameOddsTable() — with no
  // key configured, getOdds() throws a NO_ODDS_KEY-coded error with no
  // `.status` set, which the global error handler defaults to a raw 500
  // "Internal error" instead of a clear, actionable 400. Same class of
  // gap as index.js's /api/:sport/games/:eventId/odds route, which DOES
  // check this first.
  if (!hasOddsApiKeyFn()) throw badRequest("ODDS_API_KEY not configured.");
  const table = await getGameOddsTableFn(sport, leg.eventId);
  if (!table) throw notFound("No live odds table found for this game — the market may have closed.");
  const best = bestPriceFromTable(table, leg.market, ctx.side, ctx.line);
  if (!best) throw notFound("No current price found for this side — the market may have closed.");
  return best.american;
}
