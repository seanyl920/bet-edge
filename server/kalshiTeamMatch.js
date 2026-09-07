// Matches a Kalshi "game" entry (one event from kalshiApi.js's
// groupGameWinnerMarkets — a KX<LEAGUE>GAME event_ticker with its two
// team contracts) to an ESPN scoreboard event.
//
// Kalshi's own team label (yes_sub_title) is NOT a full franchise name —
// confirmed live across NFL/MLB/NBA diagnostic output: it's the team's
// city/location, plus (only when more than one team in that SPORT shares
// a location) a disambiguating suffix made of the initials of each word
// in the team's nickname:
//   "Los Angeles C" (Chargers) vs "Los Angeles R" (Rams)
//   "New York G" (Giants) vs "New York J" (Jets)
//   "Chicago C" (Cubs) vs "Chicago WS" (White Sox)
//   "Los Angeles D" (Dodgers) — vs the Angels, also nominally "Los Angeles"
// while a location with only one team in that sport gets no suffix at all:
//   "Kansas City", "Denver", "Pittsburgh", "San Antonio", "Oklahoma City",
//   "Philadelphia", "Boston", "Detroit", and "New York" for the Knicks
//   (the Nets are listed under "Brooklyn", not "New York").
// This rule reproduces every confirmed-live example seen so far, but
// hasn't been checked against every team in every league — treat a label
// that doesn't resolve cleanly as "can't match," never force a guess
// (same policy teamMatch.js already applies to The Odds API's team names).

function nicknameInitials(nickname) {
  return String(nickname || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function deriveNickname(team) {
  const { name, location, shortName } = team;
  if (name && location && name.startsWith(location)) {
    const rest = name.slice(location.length).trim();
    if (rest) return rest;
  }
  return shortName ?? "";
}

/**
 * ESPN team id -> the label Kalshi should show it under, given which other
 * teams in the same sport share its location. Takes espn.js's getTeams()
 * result ([{ id, name, shortName, abbreviation, location, logo }]).
 */
export function buildKalshiLabels(espnTeams) {
  const byLocation = new Map();
  for (const t of espnTeams ?? []) {
    const location = t.location ?? "";
    if (!byLocation.has(location)) byLocation.set(location, []);
    byLocation.get(location).push(t);
  }
  const labelByTeamId = new Map();
  for (const teams of byLocation.values()) {
    for (const t of teams) {
      const label =
        teams.length === 1 ? t.location : `${t.location} ${nicknameInitials(deriveNickname(t))}`;
      labelByTeamId.set(t.id, label);
    }
  }
  return labelByTeamId;
}

// Kalshi's occurrence_datetime is the actual scheduled start (confirmed
// live — see kalshiApi.js), so this should land very close to ESPN's own
// event.date; generous margin for clock/rounding differences only.
const MAX_TIME_DIFF_MS = 3 * 60 * 60 * 1000;

/**
 * Matches one Kalshi game entry (from groupGameWinnerMarkets) to an ESPN
 * scoreboard event, using labelByTeamId (from buildKalshiLabels) to know
 * which ESPN team each Kalshi team label refers to. Returns
 * { event, home, away } (home/away are the Kalshi team entries, i.e.
 * { ticker, name, prob }) or null if it can't match cleanly — never
 * guesses.
 */
export function matchKalshiGame(kalshiGame, espnEvents, labelByTeamId) {
  if (!kalshiGame?.teams || kalshiGame.teams.length !== 2) return null;
  const gameTime = kalshiGame.gameTime ? new Date(kalshiGame.gameTime).getTime() : null;
  if (gameTime == null || Number.isNaN(gameTime)) return null;

  const kalshiNames = kalshiGame.teams.map((t) => t.name);

  const candidates = (espnEvents ?? []).filter((e) => {
    const eTime = e.date ? new Date(e.date).getTime() : NaN;
    if (Number.isNaN(eTime) || Math.abs(eTime - gameTime) > MAX_TIME_DIFF_MS) return false;
    const homeLabel = labelByTeamId.get(e.home?.teamId);
    const awayLabel = labelByTeamId.get(e.away?.teamId);
    if (homeLabel == null || awayLabel == null) return false;
    return kalshiNames.includes(homeLabel) && kalshiNames.includes(awayLabel);
  });
  if (candidates.length !== 1) return null; // no match, or ambiguous — refuse rather than guess

  const event = candidates[0];
  const homeLabel = labelByTeamId.get(event.home.teamId);
  const awayLabel = labelByTeamId.get(event.away.teamId);
  const home = kalshiGame.teams.find((t) => t.name === homeLabel);
  const away = kalshiGame.teams.find((t) => t.name === awayLabel);
  if (!home || !away) return null;

  return { event, home, away };
}
