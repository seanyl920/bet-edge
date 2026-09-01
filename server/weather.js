// Open-Meteo forecast, reused for outdoor NFL games where wind/precip/cold
// materially affects passing offense and totals. Free, keyless, no rate-limit
// hassle for this volume of traffic.

import { cached } from "./cache.js";

async function getJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/** Forecast for a stadium at a specific kickoff time (ISO string). Returns null past the forecast horizon. */
export async function getGameWeather(lat, lon, isoKickoff) {
  const key = `weather:${lat}:${lon}:${isoKickoff.slice(0, 13)}`;
  return cached(key, 60 * 60 * 1000, async () => {
    const kickoff = new Date(isoKickoff);
    const daysOut = Math.ceil((kickoff - Date.now()) / (24 * 60 * 60 * 1000));
    if (daysOut < 0 || daysOut > 15) return null; // outside Open-Meteo's forecast horizon

    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=temperature_2m,precipitation_probability,wind_speed_10m,wind_gusts_10m,wind_direction_10m` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=16&timezone=UTC`;
    const data = await getJson(url);
    const times = data?.hourly?.time ?? [];
    const targetHour = isoKickoff.slice(0, 13); // "YYYY-MM-DDTHH"
    const idx = times.findIndex((t) => t.startsWith(targetHour));
    if (idx === -1) return null;
    return {
      tempF: data.hourly.temperature_2m[idx],
      precipProbability: data.hourly.precipitation_probability[idx],
      windMph: data.hourly.wind_speed_10m[idx],
      windGustMph: data.hourly.wind_gusts_10m[idx],
      windDirectionDeg: data.hourly.wind_direction_10m[idx],
      windDirectionCompass: degToCompass(data.hourly.wind_direction_10m[idx]),
    };
  });
}

const COMPASS_POINTS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

/** Meteorological wind direction (degrees, direction wind is coming FROM) -> compass label. */
export function degToCompass(deg) {
  if (deg == null || !Number.isFinite(deg)) return null;
  return COMPASS_POINTS[Math.round(deg / 22.5) % 16];
}

/**
 * Plain-language note on whether weather is likely to matter for this game.
 * Deliberately does NOT claim a "blowing out"/"blowing in" verdict for MLB —
 * that needs each park's precise orientation, which this app doesn't have a
 * verified source for (see parks.js). It reports wind speed + raw direction
 * and leaves the interpretation to you.
 */
export function weatherImpactNote(weather, sport = "nfl") {
  if (!weather) return null;
  const notes = [];
  const windLabel = weather.windDirectionCompass
    ? `${weather.windDirectionCompass} wind at ${Math.round(weather.windMph)}mph`
    : `wind at ${Math.round(weather.windMph)}mph`;

  if (sport === "mlb") {
    if (weather.windMph >= 12) notes.push(`${windLabel} — worth checking against this park's orientation for fly-ball effect`);
    if (weather.precipProbability >= 50) notes.push("chance of rain/delay");
    if (weather.tempF <= 45) notes.push("cold — ball carries less");
    if (weather.tempF >= 90) notes.push("hot — ball carries a bit more");
  } else {
    if (weather.windMph >= 20) notes.push(`${windLabel} — high wind, passing/kicking accuracy at risk`);
    else if (weather.windMph >= 15) notes.push(`${windLabel} — breezy, modest passing/kicking impact`);
    if (weather.precipProbability >= 60) notes.push("likely precipitation");
    if (weather.tempF <= 25) notes.push("very cold");
  }
  return notes.length ? notes.join("; ") : "no significant weather impact expected";
}
