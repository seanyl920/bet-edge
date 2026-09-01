# 🎯 BetEdge — sports betting research tool

A personal research tool for NFL, NBA, and MLB, covering two different kinds
of "find a good bet":

1. **Edge feed** — compares a simple Elo-based model against live, devigged
   sportsbook odds to surface bets that clear an expected-value threshold.
2. **Trends** (MLB) — surfaces situational stories: a player's hot/cold
   streak stacked against real matchup context (opposing starter quality,
   opposing lineup's contact ability, ballpark/weather) — e.g. a batter with
   a hit in 10 straight games facing a struggling starter. No claimed
   probability, just the real supporting factors laid out for you to judge.

It also line-shops across books, builds correlation-aware parlays, and logs
bets with closing-line value (CLV) tracking.

**Read this before you use it for real money:** see [Honesty & limits](#honesty--limits)
below. This is a starting point for research, not a prediction machine —
sports markets are efficient and most of what the edge feed finds will be
small, thin-sample edges that need your own judgment on top; the trend feed
is even more explicitly "here's a lead," not "here's a probability."

## What it does

- **Edge feed** — for every upcoming NFL/NBA/MLB game, compares this app's
  Elo win/spread probability against the market's devigged consensus
  probability at the *best available price* across books, and flags anything
  at or above your EV threshold.
- **Trends (MLB)** — scans today's/tomorrow's probable batters and starters
  for hit/RBI/power streaks and strikeout streaks, attaches the matchup
  context that makes a streak worth caring about (opposing starter's
  ERA/WHIP, opposing lineup's batting average, ballpark and weather), and
  ranks them by a transparent heuristic score — a count of stacked factors,
  explicitly *not* a win probability. Each trend card has an on-demand
  "check odds" button that looks up the matching player-prop line only when
  you click it, to protect your Odds API free-tier quota.
- **Line shopping** — full odds table per game across every book The Odds API
  covers (moneyline, spread/run-line, total).
- **Parlay builder** — combine legs into a slip (from either feed); shows the
  naive (independent) probability *and* a correlation-adjusted estimate with
  a warning whenever two legs share a game, since same-game legs are usually
  correlated and naive multiplication overstates their real hit rate.
- **Bet log & CLV** — log bets (single or parlay), record the closing line,
  and track ROI and average closing-line value — the standard way to tell if
  you have real edge independent of whether individual bets won.
- **Context, not just numbers** — Elo ratings, sample size (games actually
  folded into the rating — trust it less early in a season), injury reports,
  and outdoor-stadium weather (NFL and MLB).

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
- **The trend feed's "score" is a stacked-factor count, not a probability.**
  It adds up streak length and a matchup-quality bucket (opposing pitcher's
  ERA, or the opposing lineup's batting average) — there's no market price or
  fitted model behind it the way the edge feed has. Treat every trend as a
  research lead: read the actual streak, actual ERA/AVG, and actual weather
  before betting it, not just the score number.
- **The trend feed does not claim to know which way the wind blows relative
  to any specific park.** MLB's official rule of thumb is that a park's
  home-plate-to-outfield line should run east-northeast, but real parks
  deviate from that in ways this app couldn't verify against a live source
  while building (the sandbox it was built in blocks outbound calls to
  reference sites). So `server/parks.js` intentionally does NOT compute a
  "wind blowing out/in" verdict — it shows you raw wind speed and compass
  direction and lets you apply your own knowledge of the specific park (a
  couple of well-known quirks, like Wrigley's lake winds and Coors' altitude,
  are called out as text notes instead of geometry).
- **MLB's probable-pitcher and player-gamelog data comes from less
  consistently documented ESPN endpoints** than the team/schedule data the
  NFL/NBA side relies on (see `server/mlbData.js`). It's written defensively
  (bad shapes return empty/null instead of crashing), but if the trend feed
  comes back thin, that file is the first place to check against what ESPN
  is actually returning.
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
| MLB probable pitchers, rosters, player game logs | ESPN's site/web APIs (less consistently documented — see caveats above) | No |
| Live multi-book odds (moneyline/spread/total) | [The Odds API](https://the-odds-api.com) | **Yes** (free tier: ~500 req/mo) |
| Player-prop odds (MLB trends' "check odds") | The Odds API, fetched only on click | **Yes** |
| Outdoor-stadium weather (NFL, MLB) | [Open-Meteo](https://open-meteo.com/) | No |
| Win/margin model | Elo, built server-side from this season's completed games | No |
| Bet log | Local JSON file (`data/bets.json`) | No |

```
browser (React)
   │
   ├──► /api/:sport/games   ──► Express ──► ESPN + Open-Meteo (weather) + Elo engine
   ├──► /api/:sport/edges   ──► Express ──► ESPN + Elo engine + The Odds API (odds, cached)
   ├──► /api/mlb/trends     ──► Express ──► ESPN (probables/rosters/gamelogs) + Open-Meteo
   ├──► /api/mlb/trends/prop-odds ─► Express ──► The Odds API (on-demand, per click only)
   ├──► /api/:sport/games/:id/odds ─► Express ──► The Odds API (cached, keyed)
   ├──► /api/parlay/combine ──► Express ──► pure odds math + correlation heuristic
   └──► /api/bets           ──► Express ──► data/bets.json
```

The Odds API key stays server-side (`.env`, never shipped to the browser) and
every automatic call to it is cached (5 min for live odds) since the free
tier is limited. Player-prop odds for the trend feed are never fetched
automatically — only when you click "check odds" on a specific trend — since
that's a separate, more expensive per-event call. Without a key, games/Elo
/weather/trends still work; odds comparison, the edge feed, and prop lookups
are disabled with an in-app message rather than failing silently.

## A note on how this was built

This app was scaffolded and code-reviewed (syntax-checked, frontend built,
Express routes verified to wire up and error-handle correctly) in a sandboxed
session whose network policy blocks outbound calls to ESPN, The Odds API, and
Open-Meteo — so the live data paths could not be exercised end-to-end there.
The API clients are written defensively (timeouts, try/catch, explicit
"unavailable" states instead of crashes) for exactly this kind of real-world
flakiness, but you should still run `npm run dev` yourself and watch the
server log on first run to confirm ESPN's endpoints still match the shapes
assumed in `server/espn.js` and `server/mlbData.js` — these are unofficial
APIs and can change without notice. `server/mlbData.js`'s probable-pitcher
and gamelog parsing is the least certain part of this codebase (see
[Honesty & limits](#honesty--limits)) — its best-guess shapes were also
built without being able to reach a search engine or reference doc to verify
MLB ballpark orientation data, which is why that data was left out entirely
rather than guessed at (see `server/parks.js`).

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
  mlbData.js             MLB-specific ESPN calls: probables, rosters, gamelogs, pitcher/team stats
  statFind.js              Defensive deep-search helpers for ESPN's loosely-shaped stat blobs
  streaks.js                Pure streak/rate math over a normalized game log
  trends.js                   Builds the MLB trend feed: streaks + matchup + weather + heuristic score
  oddsApi.js                    The Odds API client (cached; player props fetched on-demand only)
  teamMatch.js                    Matches ESPN events to Odds API events
  edges.js                          Combines model + market into the edge feed
  parlay.js                          Correlation-aware parlay combination
  betlog.js                           Bet log CRUD + CLV
  weather.js                           Open-Meteo (NFL/MLB outdoor venues)
  stadiums.js                           NFL stadium coordinates + roof type
  parks.js                               MLB ballpark coordinates + roof type (no orientation/wind-direction claims — see caveats)
  cache.js                                 In-memory TTL cache
src/
  App.jsx           Tabs, sport switcher, slip state
  api.js             Frontend fetch wrappers
  components/
    EdgeFeed.jsx      Model-vs-market edge table
    TrendFeed.jsx       MLB streak+matchup trend cards, on-demand prop odds
    Games.jsx             Upcoming games grid (Elo, weather)
    GameDetail.jsx          Per-game odds table + injuries
    ParlaySlip.jsx            Slip, correlation warnings, bet logging
    BetLog.jsx                  History, CLV, ROI
    SportSwitcher.jsx            NFL/NBA/MLB toggle
    Disclaimer.jsx                 Always-visible honesty banner
```

## Extending it

- **Add a league to the edge feed**: add one entry to `server/sports.js`
  (Elo constants + ESPN/Odds API sport keys); ESPN's site API and The Odds
  API both cover NHL and most major soccer leagues with the same URL shape.
- **Add a sport to the trend feed**: `trends.js` is MLB-specific right now
  (batter streaks + starter K streaks). The same shape — pull a stat game
  log, run it through `streaks.js`, attach matchup context, score it — would
  work for e.g. an NFL receiver's target-streak vs. a weak pass defense, or
  an NBA scorer's streak vs. a weak perimeter defense; you'd write a sport-
  specific data module like `mlbData.js` and a scoring function like
  `battingTrendsForTeam`, then route `/api/:sport/trends` to it in
  `server/index.js` instead of the current MLB-only check.
- **Better model**: `elo.js`/`eloBootstrap.js` are the only places that would
  need to change to swap in a stronger model — everything downstream just
  consumes `{homeWinProb, expectedMarginHome, sampleSize}`.
- **Real correlation model**: `parlay.js`'s haircut is intentionally crude;
  a same-game copula or historical same-game-parlay hit-rate table would
  slot in there.
- **Verified park orientation**: if you can source a trustworthy per-park
  home-plate-to-outfield azimuth table, `weather.js` already computes wind
  direction in degrees (`windDirectionDeg`) — adding a real "blowing out/in"
  verdict is a matter of comparing that to each park's orientation in
  `parks.js` and is deliberately left as a TODO rather than guessed at.
