// ESPN and The Odds API each name teams slightly differently in places
// (mostly they agree on full display names like "Kansas City Chiefs", but
// this keeps things working if one of them drifts). Exact match first,
// then a loose substring fallback.

function normalize(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

// Confirmed real bug: on a doubleheader day, two ESPN events can have the
// exact same two teams — team-name matching alone can't tell them apart,
// so `.find()` silently returned whichever game happened to come first in
// the array, regardless of which one the odds event's own commence_time
// actually corresponds to (odds for Game 2 could get attached to Game 1).
// When more than one ESPN event matches by team names, disambiguate by
// start time instead of guessing — and refuse the match entirely (return
// null) rather than pick arbitrarily when time can't clearly settle it.
const CLEAR_MARGIN_MS = 30 * 60 * 1000; // the closest candidate must beat the next-closest by at least this much

function disambiguateByTime(oddsEvent, candidates) {
  if (candidates.length <= 1) return candidates[0] ?? null;
  const oddsTime = oddsEvent.commence_time ? new Date(oddsEvent.commence_time).getTime() : null;
  if (oddsTime == null || Number.isNaN(oddsTime)) return null; // can't disambiguate without a time — don't guess

  let best = null;
  let bestDiff = Infinity;
  let secondBestDiff = Infinity;
  for (const e of candidates) {
    const eTime = e.date ? new Date(e.date).getTime() : NaN;
    if (Number.isNaN(eTime)) continue;
    const diff = Math.abs(eTime - oddsTime);
    if (diff < bestDiff) {
      secondBestDiff = bestDiff;
      bestDiff = diff;
      best = e;
    } else if (diff < secondBestDiff) {
      secondBestDiff = diff;
    }
  }
  if (!best) return null;
  return secondBestDiff - bestDiff >= CLEAR_MARGIN_MS ? best : null; // ambiguous — refuse rather than guess
}

/** Match an Odds API event {home_team, away_team} to an ESPN scoreboard event. */
export function matchEspnEvent(oddsEvent, espnEvents) {
  const oHome = normalize(oddsEvent.home_team);
  const oAway = normalize(oddsEvent.away_team);

  const exactMatches = espnEvents.filter(
    (e) => normalize(e.home.name) === oHome && normalize(e.away.name) === oAway
  );
  if (exactMatches.length > 0) return disambiguateByTime(oddsEvent, exactMatches);

  // Fallback: same calendar day + both team names contained in each other.
  const oddsDate = oddsEvent.commence_time?.slice(0, 10);
  const looseMatches = espnEvents.filter((e) => {
    if (e.date?.slice(0, 10) !== oddsDate) return false;
    const eHome = normalize(e.home.name);
    const eAway = normalize(e.away.name);
    const homeMatches = eHome.includes(oHome) || oHome.includes(eHome);
    const awayMatches = eAway.includes(oAway) || oAway.includes(eAway);
    return homeMatches && awayMatches;
  });
  return disambiguateByTime(oddsEvent, looseMatches);
}
