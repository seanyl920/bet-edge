// MLB-specific CONTEXT for the game-level (moneyline/spread) edge feed —
// deliberately NOT a probability adjustment. This project's Priority 3
// instructions ask for starting-pitcher quality, lineup strength, bullpen
// availability, and park-adjusted scoring to feed into MLB game
// predictions. Converting any of those into an actual win-probability
// shift needs either a verified sabermetric formula/constant (this
// sandbox has no outbound web access to verify one against a live
// source — confirmed repeatedly this session) or enough of this app's own
// graded prediction history to fit the relationship empirically (not
// enough yet — predictionLog.js only just started running). Inventing a
// plausible-looking conversion without either would be exactly the kind
// of fabricated-precision this project's own instructions forbid.
//
// So: this is display-only context, the same treatment trends.js gives
// Savant's K%/BB%/whiff% for player props. edges.js's modelProb/EV/Kelly
// stay exactly what the Elo engine computes — nothing here touches them.
// Bullpen quality/availability and park-adjusted scoring are NOT built at
// all yet — no verified data source for recent bullpen usage exists in
// this app, and hardcoding remembered park-factor numbers without a live
// source to check them against would be the same fabrication problem.

import { getProbablePitchers, getConfirmedLineup, getPitcherGameLog } from "./mlbData.js";
import { getPitcherProfileByName } from "./savantData.js";
import { round } from "./oddsMath.js";

async function pitcherContext(pitcher, confirmedRoleInfo) {
  if (!pitcher) return null;
  const [log, savant] = await Promise.all([getPitcherGameLog(pitcher.id), getPitcherProfileByName(pitcher.name)]);

  const lastStart = log[0]?.date ? new Date(log[0].date) : null;
  // Only trust a confirmed role if it's actually for THIS pitcher — same
  // substitution guard trends.js's pitcherKTrends uses.
  const role = confirmedRoleInfo?.id === String(pitcher.id) ? confirmedRoleInfo.role : null;

  return {
    id: pitcher.id,
    name: pitcher.name,
    era: pitcher.era,
    whip: pitcher.whip,
    confirmedRole: role,
    // ISO date, not a pre-computed "days rest" — the caller knows the
    // actual game time and can compute days rest at read time without
    // this going stale between when it's fetched and when it's read.
    lastStartDate: lastStart && !Number.isNaN(lastStart.getTime()) ? lastStart.toISOString() : null,
    kPercent: savant?.kPercent ?? null,
    bbPercent: savant?.bbPercent ?? null,
    kMinusBBPercent: savant?.kPercent != null && savant?.bbPercent != null ? round(savant.kPercent - savant.bbPercent, 1) : null,
    savantSeason: savant?.season ?? null,
    savantSplitByHandedness: savant?.splitByHandedness ?? false,
  };
}

/**
 * Context-only MLB game info for one scheduled game: both probable
 * starters' quality (K-BB%, ERA/WHIP), confirmed role, last-start date,
 * and confirmed-lineup status for both sides. `null` fields mean
 * genuinely unknown/not found — never a guessed or zeroed value.
 */
export async function getMlbGameContext(espnEventId) {
  const [probables, lineup] = await Promise.all([getProbablePitchers(espnEventId), getConfirmedLineup(espnEventId)]);
  const [home, away] = await Promise.all([
    pitcherContext(probables.home, lineup.home.startingPitcherRole),
    pitcherContext(probables.away, lineup.away.startingPitcherRole),
  ]);
  return {
    home: { pitcher: home, lineupConfirmed: lineup.home.confirmed },
    away: { pitcher: away, lineupConfirmed: lineup.away.confirmed },
  };
}
