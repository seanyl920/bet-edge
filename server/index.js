import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { requireSport, SPORTS } from "./sports.js";
import { getUpcomingGames, getGameInjuries } from "./games.js";
import { getEdgeFeed, getGameOddsTable } from "./edges.js";
import { getTrendFeed, getTrendPropOdds } from "./trends.js";
import { getDailyParlay } from "./dailyParlay.js";
import { combineLegs } from "./parlay.js";
import { addBet, betLogSummary, deleteBet, getBet, listBets, updateBet } from "./betlog.js";
import { analyzeBet } from "./postmortem.js";
import { getCalibration } from "./calibration.js";
import { hasOddsApiKey } from "./oddsApi.js";
import { clearCache } from "./cache.js";

const SETTLED_RESULTS = new Set(["win", "loss", "push"]);

/** Runs the postmortem for a bet and persists it. Shared by the manual route and the auto-trigger on grading. */
async function runAnalysis(id) {
  const bet = await getBet(id);
  if (!bet) return null;
  const postmortem = await analyzeBet(bet);
  return updateBet(id, { postmortem });
}

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

app.get(
  "/api/:sport/trends",
  wrap(async (req, res) => {
    const sport = requireSport(req.params.sport);
    if (sport.key !== "mlb") {
      return res.json({ trends: [], gamesScanned: 0, note: `Trends are only built out for MLB right now.` });
    }
    const hoursAhead = req.query.hoursAhead != null ? Number(req.query.hoursAhead) : 36;
    res.json(await getTrendFeed(sport, { hoursAhead }));
  })
);

app.get(
  "/api/:sport/trends/prop-odds",
  wrap(async (req, res) => {
    const sport = requireSport(req.params.sport);
    if (!hasOddsApiKey()) return res.json({ available: false, outcomes: [] });
    const { eventId, player, type } = req.query;
    if (!eventId || !player || !type) {
      return res.status(400).json({ error: "eventId, player, and type query params are required" });
    }
    res.json(await getTrendPropOdds(sport, eventId, player, type));
  })
);

app.get(
  "/api/daily-parlay",
  wrap(async (req, res) => {
    res.json(await getDailyParlay());
  })
);

app.post(
  "/api/daily-parlay/regenerate",
  wrap(async (req, res) => {
    res.json(await getDailyParlay({ forceRegenerate: true }));
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
  "/api/bets/:id/analyze",
  wrap(async (req, res) => {
    const updated = await runAnalysis(req.params.id);
    if (!updated) return res.status(404).json({ error: "bet not found" });
    res.json(updated);
  })
);

app.get(
  "/api/calibration",
  wrap(async (req, res) => {
    res.json(await getCalibration());
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
    const updated = await updateBet(req.params.id, req.body);
    // Grading a bet (win/loss/push) automatically kicks off the postmortem —
    // "feed it back" shouldn't require a separate manual step for the common
    // case. analyze() is also exposed standalone for re-runs (game wasn't
    // final yet, ESPN hiccup, older bet you want to re-grade).
    if (SETTLED_RESULTS.has(req.body?.result) && !("postmortem" in req.body)) {
      const analyzed = await runAnalysis(req.params.id);
      return res.json(analyzed ?? updated);
    }
    res.json(updated);
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
