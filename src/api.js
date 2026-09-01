const BASE = "/api";

async function request(path, options) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  health: () => request("/health"),
  games: (sport) => request(`/${sport}/games`),
  injuries: (sport, eventId) => request(`/${sport}/games/${eventId}/injuries`),
  oddsTable: (sport, eventId) => request(`/${sport}/games/${eventId}/odds`),
  edges: (sport, threshold) => request(`/${sport}/edges?threshold=${threshold}`),
  combineParlay: (legs) =>
    request("/parlay/combine", { method: "POST", body: JSON.stringify({ legs }) }),
  listBets: () => request("/bets"),
  addBet: (bet) => request("/bets", { method: "POST", body: JSON.stringify(bet) }),
  updateBet: (id, patch) => request(`/bets/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteBet: (id) => request(`/bets/${id}`, { method: "DELETE" }),
};
