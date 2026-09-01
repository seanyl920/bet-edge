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
      `&hourly=temperature_2m,precipitation_probability,wind_speed_10m,wind_gusts_10m` +
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
    };
  });
}

/** Plain-language note on whether weather is likely to matter for this game. */
export function weatherImpactNote(weather) {
  if (!weather) return null;
  const notes = [];
  if (weather.windMph >= 20) notes.push("high wind — passing/kicking accuracy at risk");
  else if (weather.windMph >= 15) notes.push("breezy — modest passing/kicking impact");
  if (weather.precipProbability >= 60) notes.push("likely precipitation");
  if (weather.tempF <= 25) notes.push("very cold");
  return notes.length ? notes.join("; ") : "no significant weather impact expected";
}
