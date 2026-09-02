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
import { recordPrediction } from "./predictionLog.js";
import { getMlbGameContext } from "./mlbGameContext.js";
import {
  americanToDecimal,
  devigMultiplicative,
  expectedValue,
  kellyStake,
  median,
  round,
} from "./oddsMath.js";

// Below this many completed games for BOTH teams, Elo is mostly still at (or
// near) its 1500 starting point and isn't worth trusting for real edges.
const MIN_SAMPLE_SIZE = 3;

// How much to trust the Elo model over the market's own devigged price when
// computing EV/Kelly. Raw Elo vs market (weight 1.0) means a weak Elo
// estimate that's just wrong reads as a fat "edge" indistinguishable from a
// real one, and Kelly then overstakes it. Trust scales up with sample size
// (an Elo built on 3 games deserves far less weight than one built on 100)
// but is capped well under 1.0 even at a full season — this app's entire
// premise is that markets are largely efficient (see README), so nothing
// here should ever fully override the market's own price.
const ELO_TRUST_FULL_SAMPLE = 20; // games at which Elo gets its maximum trust weight
const ELO_TRUST_MAX_WEIGHT = 0.5;

function blendWithMarket(modelProb, marketProb, sampleSize) {
  if (marketProb == null) return modelProb; // nothing to blend toward
  const w = Math.min(sampleSize / ELO_TRUST_FULL_SAMPLE, 1) * ELO_TRUST_MAX_WEIGHT;
  return w * modelProb + (1 - w) * marketProb;
}

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

// Confirmed real bug: picking the most-common home point and the most-common
// away point INDEPENDENTLY doesn't guarantee they're the same market — e.g.
// home -3 could win its own vote while away +3.5 wins a separate vote, and
// the two would then get treated as complementary sides of one 2-outcome
// market (devigged together, and the away probability derived as
// 1-coverProbHome) when they're not actually paired that way by any book.
// Find the most-common (home, away) PAIR as actually quoted together, per
// book, instead.
function modalSpreadPair(homePrices, awayPrices) {
  const byBook = new Map();
  for (const h of homePrices) byBook.set(h.book, { ...(byBook.get(h.book) || {}), homePoint: h.point });
  for (const a of awayPrices) byBook.set(a.book, { ...(byBook.get(a.book) || {}), awayPoint: a.point });

  const counts = new Map();
  for (const { homePoint, awayPoint } of byBook.values()) {
    if (homePoint == null || awayPoint == null) continue;
    const key = `${homePoint}|${awayPoint}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let bestKey = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }
  if (!bestKey) return { homePoint: null, awayPoint: null };
  const [homePoint, awayPoint] = bestKey.split("|").map(Number);
  return { homePoint, awayPoint };
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
  const bestOf = (prices) =>
    prices.reduce((best, p) => {
      const decimal = americanToDecimal(p.price);
      return decimal != null && (!best || decimal > best.decimal)
        ? { book: p.book, american: p.price, decimal }
        : best;
    }, null);

  return {
    // Median, not mean — one stale or outlier book shouldn't drag "fair"
    // toward itself. This still includes the book you might end up betting
    // into (excluding it conditionally per side would need this function to
    // know which side you're pricing, which complicates the shared
    // home/away computation here for limited benefit — median already
    // blunts most of a single book's pull on its own).
    consensus: { home: median(homeProbs), away: median(awayProbs) },
    bestHome: bestOf(homePrices),
    bestAway: bestOf(awayPrices),
    numBooks: byBook.size,
  };
}

function makeEdge({ event, sport, market, side, team, line, best, modelProb, marketProb, sampleSize }) {
  // EV/Kelly are computed off the blended probability, not raw Elo — see
  // blendWithMarket above. modelProb is still reported as-is (the pure Elo
  // number) so it's visible what the model actually said before shrinkage.
  const blendedProb = blendWithMarket(modelProb, marketProb, sampleSize);
  const ev = expectedValue(blendedProb, best.decimal);
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
    blendedProb: round(blendedProb),
    marketProb: marketProb != null ? round(marketProb) : null,
    ev: round(ev),
    evPct: round(ev * 100, 2),
    kellyStakePct: round(kellyStake(blendedProb, best.decimal, 0.25) * 100, 2),
    sampleSize,
  };
}

// Logs the FULL distribution of priced edge candidates (not just the ones
// that clear the EV threshold) so a later evaluation isn't self-selected
// toward whatever already looked good — see predictionLog.js. `edge` is
// exactly what makeEdge() returns; `leg` is built to match the shape
// EdgeFeed.jsx already attaches to a manually-added leg, so postmortem.js's
// analyzeBet() can grade this later without a second implementation.
function logEdgePrediction(edge) {
  recordPrediction({
    sport: edge.sport,
    kind: "edge",
    subjectId: edge.eventId,
    subjectName: edge.matchup,
    market: edge.market,
    side: edge.side,
    point: edge.line ?? null,
    predictedProb: edge.blendedProb,
    marketProb: edge.marketProb,
    probSource: "elo-blended",
    leg: {
      label: `${edge.team} ${edge.market}${edge.line != null ? ` ${edge.line}` : ""}`,
      eventId: edge.eventId,
      commenceTime: edge.commenceTime,
      matchup: edge.matchup,
      market: edge.market,
      selection: edge.side,
      americanOdds: edge.americanOdds,
      sport: edge.sport,
      context: {
        kind: "edge",
        side: edge.side,
        team: edge.team,
        line: edge.line,
        modelProb: edge.modelProb,
        rawEloProb: edge.modelProb,
        marketProb: edge.marketProb,
        sampleSize: edge.sampleSize,
      },
    },
  });
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

    // MLB-only, display-only starting-pitcher/lineup context (see
    // mlbGameContext.js's header for why this never touches modelHomeWinProb
    // — no verified formula exists yet to convert it into one). Never lets
    // a context-fetch failure break the actual edge feed.
    const mlbContext =
      sport.key === "mlb"
        ? await getMlbGameContext(event.id).catch((err) => {
            console.warn(`[edges] getMlbGameContext failed for event ${event.id} (non-fatal): ${err.message}`);
            return null;
          })
        : null;

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
      mlbContext,
    });

    if (!trustworthy) continue;

    if (ml.bestHome) {
      const edge = makeEdge({
        event, sport, market: "moneyline", side: "home", team: event.home.name,
        best: ml.bestHome, modelProb: prediction.homeWinProb, marketProb: ml.consensus.home,
        sampleSize: prediction.sampleSize,
      });
      logEdgePrediction(edge);
      if (edge.ev >= threshold) edges.push(edge);
    }
    if (ml.bestAway) {
      const edge = makeEdge({
        event, sport, market: "moneyline", side: "away", team: event.away.name,
        best: ml.bestAway, modelProb: prediction.awayWinProb, marketProb: ml.consensus.away,
        sampleSize: prediction.sampleSize,
      });
      logEdgePrediction(edge);
      if (edge.ev >= threshold) edges.push(edge);
    }

    const { home: spHome, away: spAway } = spreadPrices(oddsEvent);
    const { homePoint, awayPoint } = modalSpreadPair(spHome, spAway);
    if (homePoint != null && awayPoint != null) {
      const homeAtPoint = spHome.filter((p) => p.point === homePoint);
      const awayAtPoint = spAway.filter((p) => p.point === awayPoint);
      const spread = consensusAndBest(homeAtPoint, awayAtPoint);
      const coverProbHome = coverProbability({
        expectedMarginHome: prediction.expectedMarginHome,
        marketSpreadHome: homePoint,
        marginSigma: prediction.marginSigma,
      });
      // Computed independently from home's side, not derived as
      // 1-coverProbHome — that shortcut silently assumed awayPoint is
      // exactly -homePoint, which modalSpreadPair no longer guarantees is
      // even the intent (real books usually do quote symmetric pairs, but
      // this no longer breaks if one doesn't). Mirrors coverProbability's
      // own math from the away side's perspective.
      const coverProbAway = coverProbability({
        expectedMarginHome: -prediction.expectedMarginHome,
        marketSpreadHome: awayPoint,
        marginSigma: prediction.marginSigma,
      });

      if (spread.bestHome) {
        const edge = makeEdge({
          event, sport, market: "spread", side: "home", team: event.home.name, line: homePoint,
          best: spread.bestHome, modelProb: coverProbHome, marketProb: spread.consensus.home,
          sampleSize: prediction.sampleSize,
        });
        logEdgePrediction(edge);
        if (edge.ev >= threshold) edges.push(edge);
      }
      if (spread.bestAway) {
        const edge = makeEdge({
          event, sport, market: "spread", side: "away", team: event.away.name, line: awayPoint,
          best: spread.bestAway, modelProb: coverProbAway, marketProb: spread.consensus.away,
          sampleSize: prediction.sampleSize,
        });
        logEdgePrediction(edge);
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
