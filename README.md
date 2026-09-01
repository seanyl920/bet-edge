# 🎯 BetEdge — sports betting research tool

A personal research tool for NFL and NBA: it compares a simple Elo-based
model against live, devigged sportsbook odds to surface bets that clear an
expected-value threshold, helps line-shop across books, and builds
correlation-aware parlays. It also logs bets and tracks closing-line value
(CLV) over time.

**Read this before you use it for real money:** see [Honesty & limits](#honesty--limits)
below. This is a starting point for research, not a prediction machine —
sports markets are efficient and most of what it finds will be small,
thin-sample edges that need your own judgment on top.

## What it does

- **Edge feed** — for every upcoming NFL/NBA game, compares this app's Elo
  win/spread probability against the market's devigged consensus probability
  at the *best available price* across books, and flags anything at or above
  your EV threshold.
- **Line shopping** — full odds table per game across every book The Odds API
  covers (moneyline, spread, total).
- **Parlay builder** — combine legs into a slip; shows the naive (independent)
  probability *and* a correlation-adjusted estimate with a warning whenever
  two legs share a game, since same-game legs are usually correlated and
  naive multiplication overstates their real hit rate.
- **Bet log & CLV** — log bets (single or parlay), record the closing line,
  and track ROI and average closing-line value — the standard way to tell if
  you have real edge independent of whether individual bets won.
- **Context, not just numbers** — Elo ratings, sample size (games actually
  folded into the rating — trust it less early in a season), injury reports,
  and NFL outdoor-stadium weather.

## Honesty & limits

- **The model is a baseline, not a finished product.** Elo here only reacts
  to final scores and home-field advantage. It has no idea about injuries,
  pace, weather, or roster changes beyond what you read yourself in the
  injury/weather panels. Treat every "edge" as a lead to research further,
  not a bet to place on faith.
- **Totals are not modeled.** This app models win probability and margin,
  not scoring — so it never claims a totals edge, only shows totals in the
  line-shopping table.
- **Small samples are real.** Early season, or after just a few games, Elo
  ratings are close to their 1500 starting point and barely mean anything.
  The sample-size badge on every game is there so you don't mistake noise
  for signal — the app hides moneyline/spread edges for games below that
  threshold entirely (see `MIN_SAMPLE_SIZE` in `server/edges.js`).
- **Devigging is an approximation.** It removes the vig by simple
  proportional scaling, not the more accurate Shin method — good enough to
  flag mispricing, not a precision instrument.
- **Correlation adjustment in the parlay builder is a heuristic haircut**,
  not a fitted correlation model. It exists so same-game parlays are never
  silently overstated — always look at both the naive and adjusted numbers.
- **This is a personal, single-user tool.** The bet log is a local JSON
  file, there's no auth, and it isn't built for sharing bets or data with
  other people.
- Sports betting is regulated differently by state/country and carries real
  financial risk. Know your local laws and never bet more than you can
  afford to lose. If it stops being fun, the National Problem Gambling
  Helpline is 1-800-522-4700.

## Architecture

| Data | Source | Key needed? |
| --- | --- | --- |
| Teams, schedules, scores, injuries | [ESPN's public site API](https://www.espn.com) (unofficial, undocumented) | No |
| Live multi-book odds (moneyline/spread/total) | [The Odds API](https://the-odds-api.com) | **Yes** (free tier: ~500 req/mo) |
| NFL outdoor-stadium weather | [Open-Meteo](https://open-meteo.com/) | No |
| Win/margin model | Elo, built server-side from this season's completed games | No |
| Bet log | Local JSON file (`data/bets.json`) | No |

```
browser (React)
   │
   ├──► /api/:sport/games   ──► Express ──► ESPN + Open-Meteo (weather) + Elo engine
   ├──► /api/:sport/edges   ──► Express ──► ESPN + Elo engine + The Odds API (odds, cached)
   ├──► /api/:sport/games/:id/odds ─► Express ──► The Odds API (cached, keyed)
   ├──► /api/parlay/combine ──► Express ──► pure odds math + correlation heuristic
   └──► /api/bets           ──► Express ──► data/bets.json
```

The Odds API key stays server-side (`.env`, never shipped to the browser) and
every call to it is cached (5 min for live odds) since the free tier is
limited. Without a key, games/Elo/weather still work; odds comparison and the
edge feed are disabled with an in-app message rather than failing silently.

## A note on how this was built

This app was scaffolded and code-reviewed (syntax-checked, frontend built,
Express routes verified to wire up and error-handle correctly) in a sandboxed
session whose network policy blocks outbound calls to ESPN, The Odds API, and
Open-Meteo — so the live data paths could not be exercised end-to-end there.
The API clients are written defensively (timeouts, try/catch, explicit
"unavailable" states instead of crashes) for exactly this kind of real-world
flakiness, but you should still run `npm run dev` yourself and watch the
server log on first run to confirm ESPN's endpoints still match the shapes
assumed in `server/espn.js` — it's an unofficial API and can change without
notice.

## Getting started

```bash
# 1. Install
npm install

# 2. Add a free Odds API key (optional but needed for edges/line-shopping)
cp .env.example .env
#   sign up at https://the-odds-api.com, then set ODDS_API_KEY=...

# 3. Run (Vite on :5173, API server on :3001)
npm run dev
```

Open http://localhost:5173.

### Production build

```bash
npm run build   # bundles the React app into dist/
npm start       # Express serves dist/ AND /api on http://localhost:3001
```

## Project layout

```
server/
  index.js        Express app + routes
  sports.js        Per-league config (Elo constants, ESPN/Odds API keys)
  elo.js            Elo rating engine + win/cover-probability math
  eloBootstrap.js    Replays this season's completed games to build live ratings
  oddsMath.js         American/decimal odds, devig, EV, Kelly stake
  espn.js               ESPN client: teams, scoreboard, schedules, injuries
  oddsApi.js             The Odds API client (cached)
  teamMatch.js             Matches ESPN events to Odds API events
  edges.js                  Combines model + market into the edge feed
  parlay.js                  Correlation-aware parlay combination
  betlog.js                   Bet log CRUD + CLV
  weather.js                   Open-Meteo (NFL outdoor stadiums)
  stadiums.js                   NFL stadium coordinates + roof type
  cache.js                       In-memory TTL cache
src/
  App.jsx           Tabs, sport switcher, slip state
  api.js             Frontend fetch wrappers
  components/
    EdgeFeed.jsx      Model-vs-market edge table
    Games.jsx          Upcoming games grid (Elo, weather)
    GameDetail.jsx      Per-game odds table + injuries
    ParlaySlip.jsx       Slip, correlation warnings, bet logging
    BetLog.jsx            History, CLV, ROI
    SportSwitcher.jsx      NFL/NBA toggle
    Disclaimer.jsx          Always-visible honesty banner
```

## Extending it

- **Add a league**: add one entry to `server/sports.js` (Elo constants +
  ESPN/Odds API sport keys); ESPN's site API and The Odds API both cover
  MLB, NHL, and most major soccer leagues with the same URL shape.
- **Better model**: `elo.js`/`eloBootstrap.js` are the only places that would
  need to change to swap in a stronger model — everything downstream just
  consumes `{homeWinProb, expectedMarginHome, sampleSize}`.
- **Real correlation model**: `parlay.js`'s haircut is intentionally crude;
  a same-game copula or historical same-game-parlay hit-rate table would
  slot in there.
