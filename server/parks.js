// MLB ballpark reference table. Coordinates are city/stadium-level
// approximations from general knowledge, not a verified source — fine for
// hourly weather lookups (a few km of slop doesn't matter at that grid
// resolution) but don't treat them as survey-grade.
//
// Deliberately NOT included: precise home-plate orientation/azimuth per
// park. That data exists (MLB Rule 1.04 recommends "east-northeast", and
// real per-park azimuth tables are out there), but this app's sandbox
// couldn't reach any source to verify specific values against, and getting
// a specific park's orientation wrong would make the weather panel actively
// mislead a real bet — worse than not claiming it. So weather.js reports
// wind speed + raw compass direction and lets you apply your own park
// knowledge, instead of the app computing a "blowing out" verdict itself.
//
// `note` flags the handful of things worth knowing that don't need precise
// geometry to be true and useful (altitude, roof, known relocations).

export const MLB_PARKS = {
  ARI: { name: "Chase Field", lat: 33.4455, lon: -112.0667, roof: "retractable" },
  ATL: { name: "Truist Park", lat: 33.8908, lon: -84.4678, roof: "open" },
  BAL: { name: "Oriole Park at Camden Yards", lat: 39.2839, lon: -76.6217, roof: "open" },
  BOS: { name: "Fenway Park", lat: 42.3467, lon: -71.0972, roof: "open" },
  CHC: { name: "Wrigley Field", lat: 41.9484, lon: -87.6553, roof: "open", note: "Famous for wind swings off the lake — check direction/speed closely." },
  CHW: { name: "Rate Field", lat: 41.8299, lon: -87.6338, roof: "open" },
  CIN: { name: "Great American Ball Park", lat: 39.0979, lon: -84.5066, roof: "open" },
  CLE: { name: "Progressive Field", lat: 41.4962, lon: -81.6852, roof: "open" },
  COL: { name: "Coors Field", lat: 39.7559, lon: -104.9942, roof: "open", note: "Mile-high altitude suppresses breaking-ball movement and thins the air — a real, well-established offense boost independent of wind." },
  DET: { name: "Comerica Park", lat: 42.339, lon: -83.0485, roof: "open" },
  HOU: { name: "Daikin Park", lat: 29.7573, lon: -95.3555, roof: "retractable" },
  KC: { name: "Kauffman Stadium", lat: 39.0517, lon: -94.4803, roof: "open" },
  LAA: { name: "Angel Stadium", lat: 33.8003, lon: -117.8827, roof: "open" },
  LAD: { name: "Dodger Stadium", lat: 34.0739, lon: -118.24, roof: "open" },
  MIA: { name: "loanDepot Park", lat: 25.7781, lon: -80.2196, roof: "dome" },
  MIL: { name: "American Family Field", lat: 43.028, lon: -87.9712, roof: "retractable" },
  MIN: { name: "Target Field", lat: 44.9817, lon: -93.2776, roof: "open" },
  NYM: { name: "Citi Field", lat: 40.7571, lon: -73.8458, roof: "open" },
  NYY: { name: "Yankee Stadium", lat: 40.8296, lon: -73.9262, roof: "open" },
  ATH: {
    name: "Sutter Health Park (temporary)",
    lat: 38.5805,
    lon: -121.5133,
    roof: "open",
    note: "Athletics' home venue has been in flux amid their Sacramento-to-Las-Vegas relocation — verify current venue before trusting this.",
    verify: true,
  },
  PHI: { name: "Citizens Bank Park", lat: 39.9061, lon: -75.1665, roof: "open" },
  PIT: { name: "PNC Park", lat: 40.4469, lon: -80.0057, roof: "open" },
  SD: { name: "Petco Park", lat: 32.7073, lon: -117.1566, roof: "open" },
  SF: { name: "Oracle Park", lat: 37.7786, lon: -122.3893, roof: "open", note: "Bay-side swirling wind and marine layer are famously pitcher-friendly — check wind speed/direction closely." },
  SEA: { name: "T-Mobile Park", lat: 47.5914, lon: -122.3325, roof: "retractable" },
  STL: { name: "Busch Stadium", lat: 38.6226, lon: -90.1928, roof: "open" },
  TB: {
    name: "Rays home venue (temporary)",
    lat: 27.9803,
    lon: -82.5065,
    roof: "open",
    note: "Tropicana Field's roof was damaged in 2024; the Rays' home venue has changed since — verify current venue before trusting this.",
    verify: true,
  },
  TEX: { name: "Globe Life Field", lat: 32.7473, lon: -97.0847, roof: "retractable" },
  TOR: { name: "Rogers Centre", lat: 43.6414, lon: -79.3894, roof: "retractable" },
  WSH: { name: "Nationals Park", lat: 38.873, lon: -77.0074, roof: "open" },
};

export function isOutdoorPark(abbreviation) {
  const p = MLB_PARKS[abbreviation];
  return p ? p.roof === "open" : null;
}
