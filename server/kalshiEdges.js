// Kalshi-priced moneyline edges — the Kalshi-native analog of edges.js's
// moneyline section. The user bets exclusively on Kalshi, not traditional
// sportsbooks, so this compares the app's Elo model against Kalshi's own
// KX<LEAGUE>GAME contract prices (confirmed live — see kalshiApi.js's
// header) instead of The Odds API's multi-book consensus.
//
// Two things are genuinely simpler here than in edges.js:
// - No devig needed. A traditional book's two-sided moneyline price bakes
//   in the vig; Kalshi's yes_bid/yes_ask on a single Yes/No contract IS
//   the market's own probability directly, spread-bounded like any order
//   book but not artificially inflated the way -110/-110 is.
// - No "best price" line-shopping. There's exactly one exchange, so the
//   price you'd actually pay is Kalshi's own yes_ask (to buy Yes) — not a
//   pick among competing books.
//
// What's NOT covered yet: spread contracts (a ladder of one binary
// contract per point threshold — confirmed live, structurally different
// from a single two-sided spread line — needs its own EV treatment, not
// this file's) and player props (real coverage not yet checked for
// MLB/NBA). This file is moneyline-only.

import { getScoreboard, getTeams } from "./espn.js";
import { getEloEngine } from "./eloBootstrap.js";
import { getMarkets, groupGameWinnerMarkets } from "./kalshiApi.js";
import { buildKalshiLabels, matchKalshiGame } from "./kalshiTeamMatch.js";
import { blendWithMarket, MIN_SAMPLE_SIZE } from "./edges.js";
import { decimalToAmerican, expectedValue, kellyStake, round } from "./oddsMath.js";

// Exported so test/kalshiEdges.test.js can check the EV math directly —
// this is the one genuinely new piece of business logic in this file (no
// devig, price the ask directly); the orchestration around it mirrors
// edges.js's already-covered getEdgeFeed(), which isn't itself
// end-to-end tested for the same reason (it needs a live Elo-bootstrap +
// ESPN + odds network round-trip to exercise fully).
export function makeKalshiEdge({ event, sport, side, team, ticker, modelProb, marketProb, askProb, sampleSize }) {
  const blendedProb = blendWithMarket(modelProb, marketProb, sampleSize);
  const decimalOdds = askProb > 0 ? 1 / askProb : null;
  const ev = expectedValue(blendedProb, decimalOdds);
  return {
    sport: sport.key,
    eventId: event.id,
    commenceTime: event.date,
    matchup: `${event.away.name} @ ${event.home.name}`,
    market: "moneyline",
    side,
    team,
    line: null,
    book: "Kalshi",
    kalshiTicker: ticker,
    americanOdds: decimalOdds != null ? decimalToAmerican(decimalOdds) : null,
    decimalOdds: decimalOdds != null ? round(decimalOdds, 3) : null,
    modelProb: round(modelProb),
    blendedProb: round(blendedProb),
    marketProb: marketProb != null ? round(marketProb) : null,
    ev: ev != null ? round(ev) : null,
    evPct: ev != null ? round(ev * 100, 2) : null,
    kellyStakePct: decimalOdds != null ? round(kellyStake(blendedProb, decimalOdds, 0.25) * 100, 2) : null,
    sampleSize,
  };
}

/**
 * Kalshi-priced moneyline edge feed for one sport — same shape as
 * getEdgeFeed()'s moneyline edges (edges.js), so it can feed the same
 * frontend/bet-log/prediction-log code paths without special-casing.
 * Returns { edges, games, available, note } — `available` is false (with
 * a `note`) when this sport has no confirmed Kalshi game series, or when
 * Kalshi's API isn't reachable (rate-limited, down, etc.) — never throws
 * out to the caller for a data-source problem, matching getEdgeFeed's own
 * NO_ODDS_KEY handling.
 */
export async function getKalshiEdgeFeed(sport, { threshold = 0.02 } = {}) {
  const seriesTicker = sport.kalshiGameSeries;
  if (!seriesTicker) {
    return { edges: [], games: [], available: false, note: `No confirmed Kalshi moneyline series for ${sport.label}.` };
  }

  const [{ engine }, scoreboard, espnTeams] = await Promise.all([
    getEloEngine(sport),
    getScoreboard(sport),
    getTeams(sport),
  ]);
  const upcoming = scoreboard.filter((e) => e.statusName === "STATUS_SCHEDULED");
  const labelByTeamId = buildKalshiLabels(espnTeams);

  let kalshiMarkets;
  try {
    kalshiMarkets = await getMarkets({ seriesTicker });
  } catch (err) {
    if (err.code === "RATE_LIMITED") {
      return { edges: [], games: [], available: false, note: "Kalshi is rate-limiting this app right now — try again shortly." };
    }
    throw err;
  }
  const kalshiGames = groupGameWinnerMarkets(kalshiMarkets);

  const edges = [];
  const games = [];

  for (const kalshiGame of kalshiGames) {
    const matched = matchKalshiGame(kalshiGame, upcoming, labelByTeamId);
    if (!matched) continue;
    const { event, home, away } = matched;

    const prediction = engine.predict({ homeTeamId: event.home.teamId, awayTeamId: event.away.teamId });
    const trustworthy = prediction.sampleSize >= MIN_SAMPLE_SIZE;

    const homeMid = home.prob;
    const awayMid = away.prob;

    games.push({
      eventId: event.id,
      commenceTime: event.date,
      home: event.home.name,
      away: event.away.name,
      homeElo: round(prediction.homeElo, 0),
      awayElo: round(prediction.awayElo, 0),
      modelHomeWinProb: round(prediction.homeWinProb),
      sampleSize: prediction.sampleSize,
      kalshiHomeProb: homeMid != null ? round(homeMid) : null,
      kalshiAwayProb: awayMid != null ? round(awayMid) : null,
    });

    if (!trustworthy) continue;
    if (home.prob == null || away.prob == null) continue; // no real Kalshi price on one side — nothing to compare against

    const homeEdge = makeKalshiEdge({
      event, sport, side: "home", team: event.home.name, ticker: home.ticker,
      modelProb: prediction.homeWinProb, marketProb: home.prob, askProb: home.askProb ?? home.prob,
      sampleSize: prediction.sampleSize,
    });
    if (homeEdge.ev != null && homeEdge.ev >= threshold) edges.push(homeEdge);

    const awayEdge = makeKalshiEdge({
      event, sport, side: "away", team: event.away.name, ticker: away.ticker,
      modelProb: prediction.awayWinProb, marketProb: away.prob, askProb: away.askProb ?? away.prob,
      sampleSize: prediction.sampleSize,
    });
    if (awayEdge.ev != null && awayEdge.ev >= threshold) edges.push(awayEdge);
  }

  edges.sort((a, b) => b.ev - a.ev);
  return { edges, games, available: true, minSampleSize: MIN_SAMPLE_SIZE };
}
