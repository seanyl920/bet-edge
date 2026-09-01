// The core "find an edge" pipeline: pull upcoming games + live odds, compare
// this app's Elo-based model probability against the devigged market
// probability at the best available price, and surface anything that clears
// an EV threshold.
//
// Two markets are modeled: moneyline (h2h) and spread. Totals are
// intentionally NOT modeled — this app has no scoring model, only a win/margin
// model, so pretending to have a totals edge would be dishonest. Totals still
// show up in the plain odds table for line-shopping.

import { getScoreboard } from "./espn.js";
import { getEloEngine } from "./eloBootstrap.js";
import { getOdds } from "./oddsApi.js";
import { matchEspnEvent } from "./teamMatch.js";
import { coverProbability } from "./elo.js";
import {
  americanToDecimal,
  devigMultiplicative,
  expectedValue,
  kellyStake,
  round,
} from "./oddsMath.js";

// Below this many completed games for BOTH teams, Elo is mostly still at (or
// near) its 1500 starting point and isn't worth trusting for real edges.
const MIN_SAMPLE_SIZE = 3;

function h2hPrices(oddsEvent) {
  const home = [];
  const away = [];
  for (const bm of oddsEvent.bookmakers ?? []) {
    const market = bm.markets?.find((m) => m.key === "h2h");
    if (!market) continue;
    const h = market.outcomes?.find((o) => o.name === oddsEvent.home_team);
    const a = market.outcomes?.find((o) => o.name === oddsEvent.away_team);
    if (h) home.push({ book: bm.title, price: h.price });
    if (a) away.push({ book: bm.title, price: a.price });
  }
  return { home, away };
}

function spreadPrices(oddsEvent) {
  const home = [];
  const away = [];
  for (const bm of oddsEvent.bookmakers ?? []) {
    const market = bm.markets?.find((m) => m.key === "spreads");
    if (!market) continue;
    const h = market.outcomes?.find((o) => o.name === oddsEvent.home_team);
    const a = market.outcomes?.find((o) => o.name === oddsEvent.away_team);
    if (h) home.push({ book: bm.title, price: h.price, point: h.point });
    if (a) away.push({ book: bm.title, price: a.price, point: a.point });
  }
  return { home, away };
}

function modalPoint(prices) {
  const counts = new Map();
  for (const p of prices) counts.set(p.point, (counts.get(p.point) || 0) + 1);
  let best = null;
  let bestCount = 0;
  for (const [point, count] of counts) {
    if (count > bestCount) {
      best = point;
      bestCount = count;
    }
  }
  return best;
}

/** Devigged consensus probability + best (line-shopped) price for each side. */
function consensusAndBest(homePrices, awayPrices) {
  const byBook = new Map();
  for (const h of homePrices) byBook.set(h.book, { ...(byBook.get(h.book) || {}), home: h.price });
  for (const a of awayPrices) byBook.set(a.book, { ...(byBook.get(a.book) || {}), away: a.price });

  const homeProbs = [];
  const awayProbs = [];
  for (const { home, away } of byBook.values()) {
    if (home == null || away == null) continue;
    const [pHome, pAway] = devigMultiplicative([americanToDecimal(home), americanToDecimal(away)]);
    if (pHome != null) {
      homeProbs.push(pHome);
      awayProbs.push(pAway);
    }
  }
  const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);

  const bestOf = (prices) =>
    prices.reduce((best, p) => {
      const decimal = americanToDecimal(p.price);
      return decimal != null && (!best || decimal > best.decimal)
        ? { book: p.book, american: p.price, decimal }
        : best;
    }, null);

  return {
    consensus: { home: avg(homeProbs), away: avg(awayProbs) },
    bestHome: bestOf(homePrices),
    bestAway: bestOf(awayPrices),
    numBooks: byBook.size,
  };
}

function makeEdge({ event, sport, market, side, team, line, best, modelProb, marketProb, sampleSize }) {
  const ev = expectedValue(modelProb, best.decimal);
  return {
    sport: sport.key,
    eventId: event.id,
    commenceTime: event.date,
    matchup: `${event.away.name} @ ${event.home.name}`,
    market,
    side,
    team,
    line: line ?? null,
    book: best.book,
    americanOdds: best.american,
    decimalOdds: round(best.decimal, 3),
    modelProb: round(modelProb),
    marketProb: marketProb != null ? round(marketProb) : null,
    ev: round(ev),
    evPct: round(ev * 100, 2),
    kellyStakePct: round(kellyStake(modelProb, best.decimal, 0.25) * 100, 2),
    sampleSize,
  };
}

export async function getEdgeFeed(sport, { threshold = 0.02 } = {}) {
  const [{ engine }, scoreboard] = await Promise.all([getEloEngine(sport), getScoreboard(sport)]);
  const upcoming = scoreboard.filter((e) => e.statusName === "STATUS_SCHEDULED");

  let oddsEvents = [];
  let quota = null;
  let oddsAvailable = true;
  try {
    const result = await getOdds(sport);
    oddsEvents = result.events ?? [];
    quota = result.quota;
  } catch (err) {
    if (err.code === "NO_ODDS_KEY") oddsAvailable = false;
    else throw err;
  }

  const edges = [];
  const games = [];

  for (const oddsEvent of oddsEvents) {
    const event = matchEspnEvent(oddsEvent, upcoming);
    if (!event) continue;

    const prediction = engine.predict({
      homeTeamId: event.home.teamId,
      awayTeamId: event.away.teamId,
    });
    const trustworthy = prediction.sampleSize >= MIN_SAMPLE_SIZE;

    const { home: h2hHome, away: h2hAway } = h2hPrices(oddsEvent);
    const ml = consensusAndBest(h2hHome, h2hAway);

    games.push({
      eventId: event.id,
      commenceTime: event.date,
      home: event.home.name,
      away: event.away.name,
      homeElo: round(prediction.homeElo, 0),
      awayElo: round(prediction.awayElo, 0),
      modelHomeWinProb: round(prediction.homeWinProb),
      sampleSize: prediction.sampleSize,
      numBooks: ml.numBooks,
    });

    if (!trustworthy) continue;

    if (ml.bestHome) {
      const edge = makeEdge({
        event, sport, market: "moneyline", side: "home", team: event.home.name,
        best: ml.bestHome, modelProb: prediction.homeWinProb, marketProb: ml.consensus.home,
        sampleSize: prediction.sampleSize,
      });
      if (edge.ev >= threshold) edges.push(edge);
    }
    if (ml.bestAway) {
      const edge = makeEdge({
        event, sport, market: "moneyline", side: "away", team: event.away.name,
        best: ml.bestAway, modelProb: prediction.awayWinProb, marketProb: ml.consensus.away,
        sampleSize: prediction.sampleSize,
      });
      if (edge.ev >= threshold) edges.push(edge);
    }

    const { home: spHome, away: spAway } = spreadPrices(oddsEvent);
    const homePoint = modalPoint(spHome);
    const awayPoint = modalPoint(spAway);
    if (homePoint != null && awayPoint != null) {
      const homeAtPoint = spHome.filter((p) => p.point === homePoint);
      const awayAtPoint = spAway.filter((p) => p.point === awayPoint);
      const spread = consensusAndBest(homeAtPoint, awayAtPoint);
      const coverProbHome = coverProbability({
        expectedMarginHome: prediction.expectedMarginHome,
        marketSpreadHome: homePoint,
        marginSigma: prediction.marginSigma,
      });

      if (spread.bestHome) {
        const edge = makeEdge({
          event, sport, market: "spread", side: "home", team: event.home.name, line: homePoint,
          best: spread.bestHome, modelProb: coverProbHome, marketProb: spread.consensus.home,
          sampleSize: prediction.sampleSize,
        });
        if (edge.ev >= threshold) edges.push(edge);
      }
      if (spread.bestAway) {
        const edge = makeEdge({
          event, sport, market: "spread", side: "away", team: event.away.name, line: awayPoint,
          best: spread.bestAway, modelProb: 1 - coverProbHome, marketProb: spread.consensus.away,
          sampleSize: prediction.sampleSize,
        });
        if (edge.ev >= threshold) edges.push(edge);
      }
    }
  }

  edges.sort((a, b) => b.ev - a.ev);
  return { edges, games, oddsAvailable, quota, minSampleSize: MIN_SAMPLE_SIZE };
}

/** Full multi-book odds table for one event, for the game-detail / line-shopping view. */
export async function getGameOddsTable(sport, espnEventId) {
  const [{ events }, scoreboard] = await Promise.all([getOdds(sport), getScoreboard(sport)]);
  const event = events.find((e) => matchEspnEvent(e, scoreboard)?.id === espnEventId);
  if (!event) return null;

  const books = (event.bookmakers ?? []).map((bm) => ({
    book: bm.title,
    lastUpdate: bm.last_update,
    markets: Object.fromEntries(
      (bm.markets ?? []).map((m) => [
        m.key,
        m.outcomes.map((o) => ({ name: o.name, price: o.price, point: o.point ?? null })),
      ])
    ),
  }));

  return {
    oddsEventId: event.id,
    homeTeam: event.home_team,
    awayTeam: event.away_team,
    commenceTime: event.commence_time,
    books,
  };
}
