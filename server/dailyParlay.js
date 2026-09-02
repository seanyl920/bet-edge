// Builds one "stack today's favorites into a big longshot" parlay per
// calendar day, persisted to disk so it doesn't silently change every time
// you look at it (or regenerate on a server restart) — only when the date
// rolls over, or you explicitly ask for a new one.
//
// Important framing, worth repeating here since it's easy to lose sight of:
// combining many short-priced favorites to reach a big target payout does
// NOT create positive expected value. Each leg individually may be close to
// fair, but the vig compounds on every leg, so the realistic combined EV is
// usually clearly negative even when every single leg looks reasonable on
// its own. This module reports the real combined probability/EV (both naive
// and correlation-adjusted) rather than dressing it up — see parlay.js.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SPORTS } from "./sports.js";
import { getEdgeFeed } from "./edges.js";
import { getTrendFeed, getTrendPropOdds } from "./trends.js";
import { combineLegs } from "./parlay.js";
import { americanToDecimal, devigMultiplicative } from "./oddsMath.js";
import { localDateKey } from "./dateUtil.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "dailyParlay.json");

const TARGET_AMERICAN_ODDS = 10000; // +10000
const TARGET_DECIMAL_ODDS = americanToDecimal(TARGET_AMERICAN_ODDS); // ~101
const MAX_LEGS = 25; // sanity cap so a thin day can't loop forever without ever hitting target
// "Favorites" means favorites: a leg only qualifies if it's more likely than
// not to hit. Without this floor, a thin candidate pool could get padded out
// with a longshot prop (e.g. "Over 2.5 HR" at +19900, ~0.5% likely) just to
// force the number up — which defeats the entire point of a favorites stack
// and quietly turns "the app's most confident picks" into one lottery
// ticket wearing a favorites costume. Better to honestly fall short of
// +10000 on a thin day than include a leg like that.
const MIN_LEG_PROB = 0.5;
// Player-prop odds are a per-event, credit-costing call (see oddsApi.js) —
// this is the ONE place in the app that fetches them without a user click,
// so it's deliberately bounded to a small, fixed number per day rather than
// checking every trend candidate.
const MAX_TREND_ODDS_CHECKS = 8;
// A lopsided team favorite routinely has a much higher raw probability than
// a well-researched player prop — sportsbooks price props tighter, so a
// legitimate streak/matchup pick often lands closer to 53-58% while a
// blowout moneyline can be 70%+. Sorting the whole pool by probability
// alone (the old behavior) meant team sides structurally crowded out props
// even when a good one qualified, which read as "just today's biggest team
// favorites" rather than what this app is actually built to find. Reserve
// up to this many of the best-qualifying trend legs first; MIN_LEG_PROB
// above still applies, so this never forces in a prop that isn't a real
// favorite — it only stops a real one from losing a probability race it
// doesn't need to win.
const TREND_RESERVED_LEGS = 3;

// See dateUtil.js — local calendar day, not UTC, for the same reason
// postmortem.js needs it: UTC midnight is mid-evening for a US MLB slate.
function todayKey() {
  return localDateKey();
}

async function readStore() {
  try {
    return JSON.parse(await readFile(FILE, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function writeStore(entry) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(entry, null, 2));
}

// This used to fail (or come back thin) with nothing in the terminal to
// explain why — both catches below were bare `catch {}`, silently
// swallowing whatever actually went wrong. Logs now, prefixed so they're
// easy to find alongside mlbData.js's [mlbData] ones.
function warn(fn, detail) {
  console.warn(`[dailyParlay] ${fn}: ${detail}`);
}

function pctStr(p) {
  return p == null ? "—" : `${Math.round(p * 100)}%`;
}

/** Every priced moneyline/spread side across every sport, not just the ones that clear an EV threshold — we want the full "favorites" universe here, not just flagged edges. Reuses the already-cached bulk odds fetch, so this costs no extra API credits. */
async function edgeCandidates() {
  const out = [];
  for (const sport of Object.values(SPORTS)) {
    try {
      const { edges, oddsAvailable } = await getEdgeFeed(sport, { threshold: -1 });
      if (!oddsAvailable) {
        warn("edgeCandidates", `${sport.key}: odds not available (no API key configured, or the odds fetch failed upstream)`);
        continue;
      }
      warn("edgeCandidates", `${sport.key}: ${edges.length} priced side(s) returned`);
      // getEdgeFeed() intentionally shows every upcoming priced game, not
      // just today's — that's the right behavior for the main Edge Feed
      // tab (you want to see next week's NFL lines there too), but wrong
      // for a "today's favorites" parlay: a leg for a game a week out
      // shouldn't be stacked into something meant to resolve today. The
      // Trends side already has this same-day restriction (gamesInWindow);
      // the edge-feed side never did. Confirmed live: the user reported
      // NFL games from a week out (season hadn't started yet) showing up
      // here. Filter to this app's own local calendar day.
      const todaysEdges = edges.filter((e) => localDateKey(e.commenceTime) === todayKey());
      if (todaysEdges.length !== edges.length) {
        warn(
          "edgeCandidates",
          `${sport.key}: ${edges.length - todaysEdges.length} of ${edges.length} priced side(s) excluded — not today's date`
        );
      }
      if (todaysEdges.length > 0) {
        const sample = todaysEdges[0];
        warn(
          "edgeCandidates",
          `${sport.key} sample edge: americanOdds=${sample.americanOdds} decimalOdds=${sample.decimalOdds} modelProb=${sample.modelProb} marketProb=${sample.marketProb} blendedProb=${sample.blendedProb} sampleSize=${sample.sampleSize}`
        );
      }
      for (const e of todaysEdges) {
        out.push({
          source: "edge",
          sport: sport.key,
          label: `${e.team}${e.line != null ? ` ${e.line > 0 ? "+" : ""}${e.line}` : ""} (${e.market})`,
          eventId: e.eventId,
          matchup: e.matchup,
          market: e.market,
          selection: `${e.team}${e.line != null ? ` ${e.line}` : ""}`,
          americanOdds: e.americanOdds,
          // blendedProb (Elo shrunk toward market), not raw modelProb — see
          // edges.js's blendWithMarket. Same reasoning as trend legs below:
          // don't feed a probability into this app's own EV math that the
          // app itself doesn't otherwise trust at face value.
          trueProb: e.blendedProb,
          probSource: "elo-blended",
          decimalOdds: americanToDecimal(e.americanOdds),
          reason:
            e.marketProb != null
              ? `Elo (${e.sampleSize}-game sample) has ${e.team} at ${pctStr(e.modelProb)}, market consensus ${pctStr(e.marketProb)} — blended to ${pctStr(e.blendedProb)}.`
              : `Elo (${e.sampleSize}-game sample) has ${e.team} at ${pctStr(e.modelProb)}; no market consensus available to blend against.`,
        });
      }
    } catch (err) {
      warn("edgeCandidates", `${sport.key}: threw — ${err.message}`);
      // one sport's odds being unavailable shouldn't sink the whole build
    }
  }
  return out;
}

/**
 * Devigged Over/Under probability for a prop, paired per book (same book's
 * Over and Under, same point) and averaged. Returns null if no book offered
 * both sides at a matching point.
 */
function devigOverUnder(outcomes) {
  const byBook = new Map();
  for (const o of outcomes) {
    if (o.side !== "Over" && o.side !== "Under") continue;
    const entry = byBook.get(o.book) ?? {};
    entry[o.side] = o;
    byBook.set(o.book, entry);
  }
  const probs = [];
  for (const { Over, Under } of byBook.values()) {
    if (!Over || !Under || Over.point !== Under.point) continue;
    const [pOver] = devigMultiplicative([americanToDecimal(Over.price), americanToDecimal(Under.price)]);
    if (pOver != null) probs.push(pOver);
  }
  return probs.length ? probs.reduce((s, p) => s + p, 0) / probs.length : null;
}

/** Top MLB trend candidates, each checked against real prop odds — bounded, see MAX_TREND_ODDS_CHECKS. */
async function trendCandidates() {
  const sport = SPORTS.mlb;
  let trends;
  try {
    ({ trends } = await getTrendFeed(sport));
  } catch (err) {
    warn("trendCandidates", `getTrendFeed threw — ${err.message}`);
    return [];
  }

  const out = [];
  for (const t of trends.slice(0, MAX_TREND_ODDS_CHECKS)) {
    try {
      const { available, outcomes } = await getTrendPropOdds(sport, t.eventId, t.player.name, t.type);
      if (!available) break; // no key configured — no point checking the rest
      // "Over" is the natural side for every trend type this app builds
      // (continue the hit/RBI/HR streak, or clear the strikeout bar).
      const overs = outcomes.filter((o) => o.side === "Over");
      if (overs.length === 0) continue;
      const best = overs.reduce((b, o) => (!b || americanToDecimal(o.price) > americanToDecimal(b.price) ? o : b), null);

      // trueProb priority: (1) this app's own calibrated hit rate for this
      // trend's bucket, when one exists — a real empirical rate from graded
      // outcomes, not a market number at all, and literally this app's
      // whole thesis; (2) a properly devigged Over/Under pair from the same
      // book; (3) if neither is available, skip this leg rather than fake a
      // probability from the single vigged price it's also priced at —
      // expectedValue(1/decimalOdds, decimalOdds) is always exactly 0 by
      // construction, which is why every past daily parlay's reported EV
      // came back at 0.0% regardless of the actual legs chosen.
      const trueProb = t.calibration?.rate ?? devigOverUnder(outcomes);
      if (trueProb == null) continue;

      out.push({
        source: "trend",
        sport: "mlb",
        label: `${t.player.name} Over ${best.point} (${t.type})`,
        eventId: t.eventId,
        matchup: t.matchup,
        market: t.type,
        selection: `Over ${best.point}`,
        americanOdds: best.price,
        trueProb,
        probSource: t.calibration?.rate != null ? "calibration" : "devig",
        decimalOdds: americanToDecimal(best.price),
        reason:
          t.calibration?.rate != null
            ? `${t.headline} — this app has graded ${t.calibration.n} similar legs at a real ${pctStr(t.calibration.rate)} hit rate.`
            : `${t.headline}${t.matchupLabel && t.matchupLabel !== "unknown" ? ` — ${t.matchupLabel}` : ""} (priced off the devigged prop line, not this app's own model — not enough graded history yet for this bucket).`,
      });
    } catch (err) {
      warn("trendCandidates", `${t.player?.name ?? t.eventId}: threw — ${err.message}`);
      // one player's prop lookup failing shouldn't sink the whole build
    }
  }
  return out;
}

/**
 * Greedily stack the highest-probability ("favorite") candidates toward the
 * target payout, preferring to spread across different games first (lower
 * correlation) before resorting to a second leg on the same game.
 */
function assembleTowardTarget(candidates) {
  const byFavorite = [...candidates].sort((a, b) => (b.trueProb ?? 0) - (a.trueProb ?? 0));

  const chosen = [];
  let combinedDecimal = 1;
  const usedEvents = new Set();

  const add = (c) => {
    chosen.push(c);
    combinedDecimal *= c.decimalOdds;
    if (c.eventId) usedEvents.add(c.eventId);
  };

  // Reserve slots for the best-qualifying trend (player-prop) legs first —
  // see TREND_RESERVED_LEGS above for why this needs to happen before the
  // general probability sort, not as part of it.
  const trendFavorites = byFavorite.filter((c) => c.source === "trend");
  for (const c of trendFavorites) {
    if (chosen.length >= TREND_RESERVED_LEGS) break;
    if (combinedDecimal >= TARGET_DECIMAL_ODDS || chosen.length >= MAX_LEGS) break;
    if (c.eventId && usedEvents.has(c.eventId)) continue;
    add(c);
  }

  for (const c of byFavorite) {
    if (combinedDecimal >= TARGET_DECIMAL_ODDS || chosen.length >= MAX_LEGS) break;
    if (chosen.includes(c)) continue;
    if (c.eventId && usedEvents.has(c.eventId)) continue;
    add(c);
  }
  if (combinedDecimal < TARGET_DECIMAL_ODDS) {
    for (const c of byFavorite) {
      if (combinedDecimal >= TARGET_DECIMAL_ODDS || chosen.length >= MAX_LEGS) break;
      if (chosen.includes(c)) continue;
      add(c);
    }
  }

  return { chosen, combinedDecimal };
}

async function build() {
  const [edges, trends] = await Promise.all([edgeCandidates(), trendCandidates()]);
  const allPriced = [...edges, ...trends].filter((c) => c.trueProb != null && c.decimalOdds != null);
  const candidates = allPriced.filter((c) => c.trueProb >= MIN_LEG_PROB);
  warn(
    "build",
    `${edges.length} edge-feed leg(s) + ${trends.length} trend leg(s) raw → ${allPriced.length} priced → ${candidates.length} favorite(s) (≥${MIN_LEG_PROB})`
  );

  if (candidates.length === 0) {
    return {
      date: todayKey(),
      generatedAt: new Date().toISOString(),
      legs: [],
      combined: null,
      note:
        allPriced.length > 0
          ? `Found ${allPriced.length} priced leg(s) today, but none were favorites (≥${Math.round(MIN_LEG_PROB * 100)}% implied) — nothing honest to build a favorites parlay from.`
          : "No priced legs available to build from — check that ODDS_API_KEY is configured and there are games today.",
      hitTarget: false,
    };
  }

  const { chosen, combinedDecimal } = assembleTowardTarget(candidates);
  const combined = combineLegs(chosen);

  return {
    date: todayKey(),
    generatedAt: new Date().toISOString(),
    targetAmericanOdds: TARGET_AMERICAN_ODDS,
    legs: chosen,
    combined,
    hitTarget: combinedDecimal >= TARGET_DECIMAL_ODDS,
    note:
      combinedDecimal >= TARGET_DECIMAL_ODDS
        ? null
        : `Only reached ${combined.combinedAmericanOdds ?? "?"} with today's available candidates — not enough priced favorites to hit +${TARGET_AMERICAN_ODDS}.`,
  };
}

/** Today's parlay — builds once per calendar day, then reads from disk. */
export async function getDailyParlay({ forceRegenerate = false } = {}) {
  if (!forceRegenerate) {
    const existing = await readStore();
    if (existing?.date === todayKey()) return existing;
  }
  const fresh = await build();
  await writeStore(fresh);
  return fresh;
}
