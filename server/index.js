import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { requireSport, SPORTS } from "./sports.js";
import { getUpcomingGames, getGameInjuries } from "./games.js";
import { getEdgeFeed, getGameOddsTable } from "./edges.js";
import { combineLegs } from "./parlay.js";
import { addBet, betLogSummary, deleteBet, listBets, updateBet } from "./betlog.js";
import { hasOddsApiKey } from "./oddsApi.js";
import { clearCache } from "./cache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, oddsApiConfigured: hasOddsApiKey(), sports: Object.keys(SPORTS) });
});

app.get(
  "/api/:sport/games",
  wrap(async (req, res) => {
    const sport = requireSport(req.params.sport);
    res.json({ games: await getUpcomingGames(sport) });
  })
);

app.get(
  "/api/:sport/games/:eventId/injuries",
  wrap(async (req, res) => {
    const sport = requireSport(req.params.sport);
    const games = await getUpcomingGames(sport);
    const game = games.find((g) => g.id === req.params.eventId);
    if (!game) return res.status(404).json({ error: "game not found" });
    res.json(await getGameInjuries(sport, game.home.teamId, game.away.teamId));
  })
);

app.get(
  "/api/:sport/games/:eventId/odds",
  wrap(async (req, res) => {
    const sport = requireSport(req.params.sport);
    if (!hasOddsApiKey()) {
      return res.status(200).json({ oddsAvailable: false, table: null });
    }
    const table = await getGameOddsTable(sport, req.params.eventId);
    res.json({ oddsAvailable: true, table });
  })
);

app.get(
  "/api/:sport/edges",
  wrap(async (req, res) => {
    const sport = requireSport(req.params.sport);
    const threshold = req.query.threshold != null ? Number(req.query.threshold) : 0.02;
    res.json(await getEdgeFeed(sport, { threshold }));
  })
);

app.post(
  "/api/parlay/combine",
  wrap(async (req, res) => {
    res.json(combineLegs(req.body?.legs));
  })
);

app.get(
  "/api/bets",
  wrap(async (req, res) => {
    res.json({ bets: await listBets(), summary: await betLogSummary() });
  })
);

app.post(
  "/api/bets",
  wrap(async (req, res) => {
    res.status(201).json(await addBet(req.body));
  })
);

app.patch(
  "/api/bets/:id",
  wrap(async (req, res) => {
    res.json(await updateBet(req.params.id, req.body));
  })
);

app.delete(
  "/api/bets/:id",
  wrap(async (req, res) => {
    const removed = await deleteBet(req.params.id);
    res.status(removed ? 204 : 404).end();
  })
);

app.post("/api/cache/clear", (req, res) => {
  clearCache(req.body?.prefix);
  res.json({ ok: true });
});

// Serve the built frontend in production (npm run build && npm start).
const distDir = path.join(__dirname, "..", "dist");
app.use(express.static(distDir));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(distDir, "index.html"), (err) => {
    if (err) next();
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Internal error" });
});

app.listen(PORT, () => {
  console.log(`bet-edge API listening on :${PORT}`);
  if (!hasOddsApiKey()) {
    console.log("  ODDS_API_KEY not set — games/Elo work, but odds & edges are disabled.");
    console.log("  Get a free key at https://the-odds-api.com and put it in .env");
  }
});
