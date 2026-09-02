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
import { americanToDecimal, decimalToImpliedProb } from "./oddsMath.js";

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

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC — fine for "which calendar day is this"
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

/** Every priced moneyline/spread side across every sport, not just the ones that clear an EV threshold — we want the full "favorites" universe here, not just flagged edges. Reuses the already-cached bulk odds fetch, so this costs no extra API credits. */
async function edgeCandidates() {
  const out = [];
  for (const sport of Object.values(SPORTS)) {
    try {
      const { edges, oddsAvailable } = await getEdgeFeed(sport, { threshold: -1 });
      if (!oddsAvailable) continue;
      for (const e of edges) {
        out.push({
          source: "edge",
          sport: sport.key,
          label: `${e.team}${e.line != null ? ` ${e.line > 0 ? "+" : ""}${e.line}` : ""} (${e.market})`,
          eventId: e.eventId,
          matchup: e.matchup,
          market: e.market,
          selection: `${e.team}${e.line != null ? ` ${e.line}` : ""}`,
          americanOdds: e.americanOdds,
          trueProb: e.modelProb,
          decimalOdds: americanToDecimal(e.americanOdds),
        });
      }
    } catch {
      // one sport's odds being unavailable shouldn't sink the whole build
    }
  }
  return out;
}

/** Top MLB trend candidates, each checked against real prop odds — bounded, see MAX_TREND_ODDS_CHECKS. */
async function trendCandidates() {
  const sport = SPORTS.mlb;
  let trends;
  try {
    ({ trends } = await getTrendFeed(sport));
  } catch {
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
      out.push({
        source: "trend",
        sport: "mlb",
        label: `${t.player.name} Over ${best.point} (${t.type})`,
        eventId: t.eventId,
        matchup: t.matchup,
        market: t.type,
        selection: `Over ${best.point}`,
        americanOdds: best.price,
        trueProb: decimalToImpliedProb(americanToDecimal(best.price)),
        decimalOdds: americanToDecimal(best.price),
      });
    } catch {
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

  for (const c of byFavorite) {
    if (combinedDecimal >= TARGET_DECIMAL_ODDS || chosen.length >= MAX_LEGS) break;
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
