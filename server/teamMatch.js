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

/** Match an Odds API event {home_team, away_team} to an ESPN scoreboard event. */
export function matchEspnEvent(oddsEvent, espnEvents) {
  const oHome = normalize(oddsEvent.home_team);
  const oAway = normalize(oddsEvent.away_team);

  let match = espnEvents.find(
    (e) => normalize(e.home.name) === oHome && normalize(e.away.name) === oAway
  );
  if (match) return match;

  // Fallback: same calendar day + both team names contained in each other.
  const oddsDate = oddsEvent.commence_time?.slice(0, 10);
  match = espnEvents.find((e) => {
    if (e.date?.slice(0, 10) !== oddsDate) return false;
    const eHome = normalize(e.home.name);
    const eAway = normalize(e.away.name);
    const homeMatches = eHome.includes(oHome) || oHome.includes(eHome);
    const awayMatches = eAway.includes(oAway) || oAway.includes(eAway);
    return homeMatches && awayMatches;
  });
  return match ?? null;
}
