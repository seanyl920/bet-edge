// First-ever test coverage for weather.js's pure helpers (degToCompass,
// weatherImpactNote) — getGameWeather itself is a live Open-Meteo fetch,
// out of scope here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { degToCompass, weatherImpactNote } from "../server/weather.js";

test("degToCompass maps the 16 cardinal/intercardinal points correctly", () => {
  assert.equal(degToCompass(0), "N");
  assert.equal(degToCompass(90), "E");
  assert.equal(degToCompass(180), "S");
  assert.equal(degToCompass(270), "W");
});

test("degToCompass wraps 360 back to N, not undefined", () => {
  assert.equal(degToCompass(360), "N");
});

test("degToCompass rounds to the nearest compass point", () => {
  assert.equal(degToCompass(10), "N"); // closer to 0 than to 22.5
  assert.equal(degToCompass(20), "NNE"); // closer to 22.5 than to 0
});

test("degToCompass returns null (never throws or guesses) for a missing/non-finite input", () => {
  assert.equal(degToCompass(null), null);
  assert.equal(degToCompass(undefined), null);
  assert.equal(degToCompass(NaN), null);
});

test("weatherImpactNote returns null when there's no weather data at all", () => {
  assert.equal(weatherImpactNote(null), null);
});

test("weatherImpactNote (MLB) flags high wind, rain chance, and temperature extremes", () => {
  const hot = weatherImpactNote({ windMph: 5, precipProbability: 0, tempF: 95, windDirectionCompass: null }, "mlb");
  assert.match(hot, /hot/);

  const cold = weatherImpactNote({ windMph: 5, precipProbability: 0, tempF: 30, windDirectionCompass: null }, "mlb");
  assert.match(cold, /cold/);

  const windy = weatherImpactNote({ windMph: 15, precipProbability: 0, tempF: 70, windDirectionCompass: "NW" }, "mlb");
  assert.match(windy, /NW wind/);
  assert.match(windy, /orientation/, "MLB must never claim a blowing-in/out verdict — only flag it for the park's own orientation");

  const rain = weatherImpactNote({ windMph: 5, precipProbability: 70, tempF: 70, windDirectionCompass: null }, "mlb");
  assert.match(rain, /rain/);
});

test("weatherImpactNote (MLB) below all thresholds reports no significant impact", () => {
  const mild = weatherImpactNote({ windMph: 5, precipProbability: 10, tempF: 70, windDirectionCompass: null }, "mlb");
  assert.equal(mild, "no significant weather impact expected");
});

test("weatherImpactNote (NFL default) uses NFL's own thresholds, distinct from MLB's", () => {
  // 15mph triggers NFL's "breezy" note but is below MLB's flagging threshold in spirit — the two sports use independent scales.
  const note = weatherImpactNote({ windMph: 15, precipProbability: 0, tempF: 70, windDirectionCompass: "N" });
  assert.match(note, /breezy/);
});

test("weatherImpactNote (NFL) escalates to 'high wind' above 20mph instead of just 'breezy'", () => {
  const note = weatherImpactNote({ windMph: 22, precipProbability: 0, tempF: 70, windDirectionCompass: "N" }, "nfl");
  assert.match(note, /high wind/);
});

test("weatherImpactNote can report multiple notes joined together", () => {
  const note = weatherImpactNote({ windMph: 25, precipProbability: 65, tempF: 20, windDirectionCompass: "N" }, "nfl");
  assert.match(note, /high wind/);
  assert.match(note, /precipitation/);
  assert.match(note, /very cold/);
});
