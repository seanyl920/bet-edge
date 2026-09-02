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
// Confirmed real follow-up bug: the single-candidate shortcut below
// skipped time validation entirely, on the reasoning that "only one
// candidate left, nothing to disambiguate." But on a doubleheader day,
// once Game 1 moves out of STATUS_SCHEDULED (it's started), the ESPN
// events list this function is given can shrink to just Game 2 — and if
// Game 1's odds are still floating around (a lagged/live quote), that
// event would sail through as the sole "candidate" with zero time check
// at all, matching Game 1's odds onto Game 2. A single candidate still
// has to be within a sane distance of the odds event's own time, not just
// be the only name match.
const MAX_ALLOWED_DIFF_MS = 3 * 60 * 60 * 1000; // generous for real clock/rounding differences, tight enough to reject a genuinely different game

function disambiguateByTime(oddsEvent, candidates) {
  const oddsTime = oddsEvent.commence_time ? new Date(oddsEvent.commence_time).getTime() : null;
  if (oddsTime == null || Number.isNaN(oddsTime)) return null; // can't validate without a time — don't guess, even for one candidate

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
  if (!best || bestDiff > MAX_ALLOWED_DIFF_MS) return null; // no candidate close enough in time — don't guess
  if (candidates.length === 1) return best; // one candidate, and it passed the absolute time check above
  return secondBestDiff - bestDiff >= CLEAR_MARGIN_MS ? best : null; // multiple candidates — ambiguous unless one is clearly closest
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
