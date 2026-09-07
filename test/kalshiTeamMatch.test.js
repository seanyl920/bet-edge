// First-ever test coverage for kalshiTeamMatch.js. buildKalshiLabels's
// disambiguation rule (location + nickname initials, only when the
// location is shared) is checked against every real Kalshi team label
// confirmed live so far (see kalshiTeamMatch.js's own header) — Chargers/
// Rams, Giants/Jets, Cubs/White Sox, plus single-team locations that
// should get NO suffix (Chiefs, Broncos, Spurs, Knicks).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildKalshiLabels, matchKalshiGame } from "../server/kalshiTeamMatch.js";

function espnTeam({ id, name, shortName, location }) {
  return { id, name, shortName, abbreviation: null, location, logo: null };
}
function espnEvent({ id, date, homeTeamId, awayTeamId }) {
  return { id, date, home: { teamId: homeTeamId }, away: { teamId: awayTeamId } };
}

const NFL_TEAMS = [
  espnTeam({ id: "kc", name: "Kansas City Chiefs", shortName: "Chiefs", location: "Kansas City" }),
  espnTeam({ id: "den", name: "Denver Broncos", shortName: "Broncos", location: "Denver" }),
  espnTeam({ id: "lac", name: "Los Angeles Chargers", shortName: "Chargers", location: "Los Angeles" }),
  espnTeam({ id: "lar", name: "Los Angeles Rams", shortName: "Rams", location: "Los Angeles" }),
  espnTeam({ id: "nyg", name: "New York Giants", shortName: "Giants", location: "New York" }),
  espnTeam({ id: "nyj", name: "New York Jets", shortName: "Jets", location: "New York" }),
];

const MLB_TEAMS = [
  espnTeam({ id: "chc", name: "Chicago Cubs", shortName: "Cubs", location: "Chicago" }),
  espnTeam({ id: "cws", name: "Chicago White Sox", shortName: "White Sox", location: "Chicago" }),
  espnTeam({ id: "pit", name: "Pittsburgh Pirates", shortName: "Pirates", location: "Pittsburgh" }),
];

const NBA_TEAMS = [
  espnTeam({ id: "sas", name: "San Antonio Spurs", shortName: "Spurs", location: "San Antonio" }),
  espnTeam({ id: "nyk", name: "New York Knicks", shortName: "Knicks", location: "New York" }),
];

test("buildKalshiLabels leaves a unique-location team's label as just the city", () => {
  const labels = buildKalshiLabels(NFL_TEAMS);
  assert.equal(labels.get("kc"), "Kansas City");
  assert.equal(labels.get("den"), "Denver");
});

test("buildKalshiLabels appends nickname initials only when the location is shared — matches real confirmed Kalshi labels", () => {
  const labels = buildKalshiLabels(NFL_TEAMS);
  assert.equal(labels.get("lac"), "Los Angeles C"); // Chargers — confirmed live
  assert.equal(labels.get("lar"), "Los Angeles R"); // Rams — confirmed live
  assert.equal(labels.get("nyg"), "New York G"); // Giants — confirmed live
  assert.equal(labels.get("nyj"), "New York J"); // Jets — confirmed live
});

test("buildKalshiLabels handles a two-word nickname's initials (White Sox -> WS) — confirmed live", () => {
  const labels = buildKalshiLabels(MLB_TEAMS);
  assert.equal(labels.get("chc"), "Chicago C"); // Cubs — confirmed live
  assert.equal(labels.get("cws"), "Chicago WS"); // White Sox — confirmed live
  assert.equal(labels.get("pit"), "Pittsburgh"); // unique location, no suffix
});

test("buildKalshiLabels gives the Knicks a bare 'New York' since the Nets are listed under Brooklyn, not New York", () => {
  const labels = buildKalshiLabels(NBA_TEAMS);
  assert.equal(labels.get("nyk"), "New York");
  assert.equal(labels.get("sas"), "San Antonio");
});

test("matchKalshiGame matches a real-shaped Kalshi game entry to the right ESPN event and assigns home/away correctly", () => {
  const labels = buildKalshiLabels(NFL_TEAMS);
  const events = [espnEvent({ id: "espn1", date: "2026-09-15T03:15:00Z", homeTeamId: "kc", awayTeamId: "den" })];
  const kalshiGame = {
    eventTicker: "KXNFLGAME-26SEP14DENKC",
    gameTime: "2026-09-15T03:15:00Z",
    teams: [
      { ticker: "KXNFLGAME-26SEP14DENKC-KC", name: "Kansas City", prob: 0.565 },
      { ticker: "KXNFLGAME-26SEP14DENKC-DEN", name: "Denver", prob: 0.445 },
    ],
  };
  const result = matchKalshiGame(kalshiGame, events, labels);
  assert.equal(result.event.id, "espn1");
  assert.equal(result.home.name, "Kansas City");
  assert.equal(result.away.name, "Denver");
});

test("matchKalshiGame disambiguates multi-team cities correctly (Chargers vs Rams, both 'Los Angeles')", () => {
  const labels = buildKalshiLabels(NFL_TEAMS);
  const events = [espnEvent({ id: "espn1", date: "2026-09-13T23:25:00Z", homeTeamId: "lac", awayTeamId: "lar" })];
  const kalshiGame = {
    eventTicker: "KXNFLGAME-26SEP13LARLAC",
    gameTime: "2026-09-13T23:25:00Z",
    teams: [
      { ticker: "t1", name: "Los Angeles C", prob: 0.6 },
      { ticker: "t2", name: "Los Angeles R", prob: 0.4 },
    ],
  };
  const result = matchKalshiGame(kalshiGame, events, labels);
  assert.equal(result.home.name, "Los Angeles C");
  assert.equal(result.away.name, "Los Angeles R");
});

test("matchKalshiGame refuses to guess when no ESPN event is close enough in time", () => {
  const labels = buildKalshiLabels(NFL_TEAMS);
  const events = [espnEvent({ id: "espn1", date: "2026-09-15T03:15:00Z", homeTeamId: "kc", awayTeamId: "den" })];
  const kalshiGame = {
    eventTicker: "KXNFLGAME-x",
    gameTime: "2026-09-16T12:00:00Z", // far off
    teams: [
      { ticker: "t1", name: "Kansas City", prob: 0.5 },
      { ticker: "t2", name: "Denver", prob: 0.5 },
    ],
  };
  assert.equal(matchKalshiGame(kalshiGame, events, labels), null);
});

test("matchKalshiGame returns null (never throws) for malformed input", () => {
  const labels = buildKalshiLabels(NFL_TEAMS);
  assert.equal(matchKalshiGame(null, [], labels), null);
  assert.equal(matchKalshiGame({ teams: [] }, [], labels), null);
  assert.equal(matchKalshiGame({ teams: [{ name: "Only One" }] }, [], labels), null);
  assert.equal(matchKalshiGame({ teams: [{}, {}], gameTime: null }, [], labels), null);
});
