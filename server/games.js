import { getScoreboard, getTeamInjuries } from "./espn.js";
import { getEloEngine } from "./eloBootstrap.js";
import { getGameWeather, weatherImpactNote } from "./weather.js";
import { NFL_STADIUMS } from "./stadiums.js";
import { MLB_PARKS } from "./parks.js";
import { round } from "./oddsMath.js";

function venueTable(sportKey) {
  return sportKey === "mlb" ? MLB_PARKS : sportKey === "nfl" ? NFL_STADIUMS : null;
}

/** Upcoming games for a sport, enriched with Elo ratings and (NFL) weather. */
export async function getUpcomingGames(sport) {
  const [{ engine }, scoreboard] = await Promise.all([
    getEloEngine(sport),
    getScoreboard(sport),
  ]);

  const upcoming = scoreboard.filter((e) => e.statusName === "STATUS_SCHEDULED");

  const games = await Promise.all(
    upcoming.map(async (ev) => {
      const prediction = engine.predict({
        homeTeamId: ev.home.teamId,
        awayTeamId: ev.away.teamId,
      });

      let weather = null;
      if (sport.outdoor) {
        const venue = venueTable(sport.key)?.[ev.home.abbreviation];
        if (venue?.roof === "open") {
          try {
            const w = await getGameWeather(venue.lat, venue.lon, ev.date);
            weather = w ? { ...w, note: weatherImpactNote(w, sport.key), venueNote: venue.note ?? null } : null;
          } catch {
            weather = null;
          }
        }
      }

      return {
        id: ev.id,
        date: ev.date,
        name: ev.name,
        venue: ev.venue,
        home: { ...ev.home, elo: round(prediction.homeElo, 0) },
        away: { ...ev.away, elo: round(prediction.awayElo, 0) },
        model: {
          homeWinProb: round(prediction.homeWinProb),
          awayWinProb: round(prediction.awayWinProb),
          expectedMarginHome: round(prediction.expectedMarginHome, 1),
          sampleSize: prediction.sampleSize,
        },
        weather,
      };
    })
  );

  return games;
}

export async function getGameInjuries(sport, homeTeamId, awayTeamId) {
  const [home, away] = await Promise.all([
    getTeamInjuries(sport, homeTeamId).catch(() => null),
    getTeamInjuries(sport, awayTeamId).catch(() => null),
  ]);
  return { home, away };
}
