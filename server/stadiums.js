// NFL stadium coordinates + roof type, keyed by ESPN team abbreviation.
// Used to decide which games are even worth a weather check (dome/retractable
// closed games don't need one) and where to point the weather API.
// Coordinates are approximate (stadium-level), which is plenty precise for
// wind/precip/temp checks.

export const NFL_STADIUMS = {
  ARI: { name: "State Farm Stadium", lat: 33.5276, lon: -112.2626, roof: "retractable" },
  ATL: { name: "Mercedes-Benz Stadium", lat: 33.7554, lon: -84.4008, roof: "dome" },
  BAL: { name: "M&T Bank Stadium", lat: 39.278, lon: -76.6227, roof: "open" },
  BUF: { name: "Highmark Stadium", lat: 42.7738, lon: -78.787, roof: "open" },
  CAR: { name: "Bank of America Stadium", lat: 35.2258, lon: -80.8528, roof: "open" },
  CHI: { name: "Soldier Field", lat: 41.8623, lon: -87.6167, roof: "open" },
  CIN: { name: "Paycor Stadium", lat: 39.095, lon: -84.516, roof: "open" },
  CLE: { name: "Huntington Bank Field", lat: 41.5061, lon: -81.6995, roof: "open" },
  DAL: { name: "AT&T Stadium", lat: 32.7473, lon: -97.0945, roof: "retractable" },
  DEN: { name: "Empower Field at Mile High", lat: 39.7439, lon: -105.02, roof: "open" },
  DET: { name: "Ford Field", lat: 42.34, lon: -83.0456, roof: "dome" },
  GB: { name: "Lambeau Field", lat: 44.5013, lon: -88.0622, roof: "open" },
  HOU: { name: "NRG Stadium", lat: 29.6847, lon: -95.4107, roof: "retractable" },
  IND: { name: "Lucas Oil Stadium", lat: 39.7601, lon: -86.1639, roof: "retractable" },
  JAX: { name: "EverBank Stadium", lat: 30.3239, lon: -81.6373, roof: "open" },
  KC: { name: "GEHA Field at Arrowhead Stadium", lat: 39.0489, lon: -94.4839, roof: "open" },
  LV: { name: "Allegiant Stadium", lat: 36.0909, lon: -115.1833, roof: "dome" },
  LAC: { name: "SoFi Stadium", lat: 33.9535, lon: -118.3392, roof: "dome" },
  LAR: { name: "SoFi Stadium", lat: 33.9535, lon: -118.3392, roof: "dome" },
  MIA: { name: "Hard Rock Stadium", lat: 25.958, lon: -80.2389, roof: "open" },
  MIN: { name: "U.S. Bank Stadium", lat: 44.9737, lon: -93.2578, roof: "dome" },
  NE: { name: "Gillette Stadium", lat: 42.0909, lon: -71.2643, roof: "open" },
  NO: { name: "Caesars Superdome", lat: 29.9511, lon: -90.0812, roof: "dome" },
  NYG: { name: "MetLife Stadium", lat: 40.8135, lon: -74.0745, roof: "open" },
  NYJ: { name: "MetLife Stadium", lat: 40.8135, lon: -74.0745, roof: "open" },
  PHI: { name: "Lincoln Financial Field", lat: 39.9008, lon: -75.1675, roof: "open" },
  PIT: { name: "Acrisure Stadium", lat: 40.4468, lon: -80.0158, roof: "open" },
  SF: { name: "Levi's Stadium", lat: 37.403, lon: -121.9694, roof: "open" },
  SEA: { name: "Lumen Field", lat: 47.5952, lon: -122.3316, roof: "open" },
  TB: { name: "Raymond James Stadium", lat: 27.9759, lon: -82.5033, roof: "open" },
  TEN: { name: "Nissan Stadium", lat: 36.1665, lon: -86.7713, roof: "open" },
  WSH: { name: "Commanders Field", lat: 38.9077, lon: -76.8645, roof: "open" },
};

export function isOutdoor(abbreviation) {
  const s = NFL_STADIUMS[abbreviation];
  return s ? s.roof === "open" : null;
}
