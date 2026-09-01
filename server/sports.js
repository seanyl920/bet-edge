// Sport registry: everything that differs between leagues lives here.
// Adding a new league later means adding one entry to this file.

export const SPORTS = {
  nfl: {
    key: "nfl",
    label: "NFL",
    espnSport: "football",
    espnLeague: "nfl",
    oddsApiKey: "americanfootball_nfl",
    elo: {
      k: 20,
      homeFieldAdvantage: 48, // Elo points, ~538's NFL estimate
      // Elo points per point of expected scoring margin (538's rule of thumb).
      pointsPerElo: 25,
      // Std dev of NFL final-score margin, used to turn an expected margin
      // into a cover probability against a market spread.
      marginSigma: 13.86,
    },
    outdoor: true, // has open-air stadiums worth checking weather for
  },
  nba: {
    key: "nba",
    label: "NBA",
    espnSport: "basketball",
    espnLeague: "nba",
    oddsApiKey: "basketball_nba",
    elo: {
      k: 20,
      homeFieldAdvantage: 100,
      pointsPerElo: 28,
      marginSigma: 12.0,
    },
    outdoor: false, // all games are indoor; weather is irrelevant
  },
  mlb: {
    key: "mlb",
    label: "MLB",
    espnSport: "baseball",
    espnLeague: "mlb",
    oddsApiKey: "baseball_mlb",
    elo: {
      k: 4, // MLB has ~10x the games of NFL and is high-variance per game; move ratings slowly
      homeFieldAdvantage: 24,
      pointsPerElo: 60, // run differential moves much less per Elo point than NFL/NBA scoring margin
      marginSigma: 3.4, // approx std dev of MLB run differential
    },
    outdoor: true,
  },
};

export function requireSport(sportParam) {
  const sport = SPORTS[String(sportParam || "").toLowerCase()];
  if (!sport) {
    const err = new Error(
      `Unknown sport "${sportParam}". Supported: ${Object.keys(SPORTS).join(", ")}`
    );
    err.status = 400;
    throw err;
  }
  return sport;
}
