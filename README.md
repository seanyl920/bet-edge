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
  context that makes a streak worth caring about (opposing starter's ERA,
  opposing lineup's batting average, this-season history vs today's specific
  opponent team, ballpark and weather), and ranks them by a transparent
  heuristic score — a count of stacked factors, explicitly *not* a win
  probability. A batter with real history against today's opponent (15+ AB,
  hitting .300+) shows up even without a current streak, as its own
  "Matchup history" trend. Each trend card has an on-demand "check odds"
  button that looks up the matching player-prop line only when you click it,
  to protect your Odds API free-tier quota.
- **Line shopping** — full odds table per game across every book The Odds API
  covers (moneyline, spread/run-line, total).
- **Parlay builder** — combine legs into a slip (from either feed); shows the
  naive (independent) probability *and* a correlation-adjusted estimate with
  a warning whenever two legs share a game, since same-game legs are usually
  correlated and naive multiplication overstates their real hit rate.
- **Bet log & CLV** — log bets (single or parlay), record the closing line,
  and track ROI and average closing-line value — the standard way to tell if
  you have real edge independent of whether individual bets won.
- **Postmortem & calibration (the feedback loop)** — grade a bet win/loss/push
  and the app automatically looks up what actually happened in each leg
  (did the streak continue? which side covered?) and shows a plain
  right/wrong breakdown, not just the bet's overall result. Every graded leg
  feeds a **Calibration** table: real hit rates per trend type/score bucket
  and per edge-feed model-probability bucket, computed fresh from your own
  bet log. Once a bucket has enough graded history (15+ legs), the Trends
  feed automatically ranks by that bucket's real hit rate instead of the
  heuristic score — visibly, with a badge showing which one drove the
  ranking. See [How the feedback loop works](#how-the-feedback-loop-works).
- **Context, not just numbers** — Elo ratings, sample size (games actually
  folded into the rating — trust it less early in a season), injury reports,
  and outdoor-stadium weather (NFL and MLB).
- **Daily longshot parlay** — one auto-built parlay per calendar day, stacking
  today's shortest-priced ("favorite") plays across the edge feed and MLB
  trends toward a +10000 target payout. See [Daily longshot parlay](#daily-longshot-parlay)
  below before trusting this one — it's a recreational construct, not a
  value bet, and the app says so on the page itself, not just here.

## Daily longshot parlay

Once a day (the first time you load the tab after the calendar date rolls
over — this is a local dev-server tool, not an always-on background job, so
"once a day" means "once per day you actually open it," persisted to
`data/dailyParlay.json` so it doesn't change again until the date rolls or
you hit Regenerate), the app assembles one big parlay from today's most
heavily-favored plays: every priced moneyline/spread side across every sport
(not just the ones flagged as +EV — the full "favorites" universe), plus a
bounded number of MLB trend candidates checked against real player-prop
odds. It greedily stacks the shortest-priced legs, preferring different
games over stacking the same game twice, until the combined price reaches
roughly **+10000**.

**Read this before betting it for real:** combining many favorites into a
big multiplier does not create positive expected value. The vig compounds on
every leg — reaching a ~100x payout typically takes 10+ legs, and even if
every individual leg were priced perfectly fairly, that many legs multiplied
together still lands on a clearly negative combined EV most of the time in
practice, because real prices always carry some vig. The page shows the real
naive and correlation-adjusted combined probability/EV, not a rosier number
— treat it as a fun, structured longshot bet (the kind of parlay people
build for the entertainment of a big potential payout), not a "the app found
you free money" claim.

Because player-prop odds cost API credits per lookup and this is the one
place in the app that fetches them without you clicking anything, it's
capped at `MAX_TREND_ODDS_CHECKS` (8) trend candidates per day, in
`server/dailyParlay.js`.

## How the feedback loop works

1. **Snapshot at bet time.** Every leg added to the slip (from the Edge feed
   or Trends) carries a `context` blob with whatever made it a candidate —
   for a trend leg, the player, streak value, matchup label, and score; for
   an edge-feed leg, the side, line, model probability, and market
   probability. This is stored with the bet in `data/bets.json`.
2. **Grade the bet.** In the Bet log tab, mark a bet win/loss/push (and
   optionally its closing line, for CLV). This automatically triggers a
   postmortem.
3. **Postmortem** (`server/postmortem.js`) looks up, per leg, what actually
   happened: for a trend leg, it re-fetches that player's game log and reads
   the actual stat for that specific game (hits, HRs, RBIs, or Ks) and
   compares it to the line/side you bet; for an edge-feed leg, it fetches
   the final score and checks who actually covered. Each leg comes back
   marked ✓ / ✗ / unknown (unknown when the game isn't final yet, or an
   older bet is missing the snapshot data), with a plain-language note —
   never a silent guess. You can re-run this anytime from the Bet log tab
   ("Re-analyze") if a game wasn't final yet the first time.
4. **Calibration** (`server/calibration.js`) aggregates every graded leg
   across your whole bet log into buckets — e.g. "MLB hitStreak, score
   9-11" — and computes the real hit rate and sample size for each. This is
   a plain frequency table, not a trained model: no bucket is trusted (or
   shown as "calibrated") until it has at least 15 graded legs, since a
   handful of bets can make a fluke streak look meaningful.
5. **Auto-applied ranking.** The Trends feed checks calibration for each
   trend's bucket before ranking. If that bucket is calibrated, the trend is
   ranked by the real historical hit rate (shown as a green "% historically"
   badge) instead of the heuristic score (blue "score N" badge) — so the
   feed actually gets better calibrated to your specific betting patterns
   over time, and it's always visible on the card which one is driving the
   order.

This only ever learns from bets **you** logged and graded — there's no
external dataset or pretraining behind it, so early on (few graded bets)
almost nothing will be calibrated, and that's expected. The Calibration tab
shows the full table, including buckets that aren't calibrated yet, so you
can see how close a signal is to having enough data behind it.

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
- **"Vs this team" history is this-season-only, and 15 at-bats is still a
  small sample.** This app never got a reliable read on whether ESPN's
  gamelog exposes prior seasons (see `server/mlbData.js`), so this can be
  legitimately empty or thin for a team a batter has actually owned for
  years, and a hot 15-AB stretch this year can just as easily be noise. The
  minimum-AB gate (`VS_TEAM_MIN_AB` in `server/trends.js`) exists so it
  isn't 3 lucky swings, not because 15 AB is statistically solid — read the
  actual `H-for-AB` line, not just the average, before trusting it. "Vs this
  specific pitcher" (a different, harder question) isn't built at all —
  no verified data source for it yet.
- **MLB's probable-pitcher and player-gamelog data comes from less
  consistently documented ESPN endpoints** than the team/schedule data the
  NFL/NBA side relies on (see `server/mlbData.js`). It's written defensively
  (bad shapes return empty/null instead of crashing), but if the trend feed
  comes back thin, that file is the first place to check against what ESPN
  is actually returning.
- **Calibration is a frequency table over your own small sample, not a
  trained model.** 15 graded legs is enough to stop a single lucky/unlucky
  bet from dominating a bucket, not enough to be statistically rigorous.
  Treat a freshly-calibrated bucket as "this has actually happened at this
  rate so far," not as a guarantee it continues — and keep grading bets, since
  every bucket's confidence only grows with more data.
- **Postmortem grading depends on the same less-verified MLB endpoints**
  flagged above for the trend feed itself, plus the assumption that a
  player's game log lines up with the bet's `eventId` or date. When it
  can't confirm a match, a leg comes back "unknown" rather than a guessed
  hit/miss — but that means some legs may never get graded even after the
  game is long over, depending on what ESPN actually returns.
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
   ├──► /api/bets, /api/bets/:id  ──► Express ──► data/bets.json
   ├──► /api/bets/:id/analyze ──► Express ──► ESPN (per-leg outcome lookup) ──► data/bets.json
   ├──► /api/calibration     ──► Express ──► aggregates graded legs from data/bets.json
   └──► /api/daily-parlay    ──► Express ──► edge feed + trend feed + bounded prop-odds checks ──► data/dailyParlay.json
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
  postmortem.js                         Grades a settled bet's legs against what actually happened
  calibration.js                          Aggregates graded legs into real hit-rate buckets
  dailyParlay.js                            Auto-builds one +10000 "favorites" longshot parlay per day
  weather.js                           Open-Meteo (NFL/MLB outdoor venues)
  stadiums.js                           NFL stadium coordinates + roof type
  parks.js                               MLB ballpark coordinates + roof type (no orientation/wind-direction claims — see caveats)
  cache.js                                 In-memory TTL cache
src/
  App.jsx           Tabs, sport switcher, slip state
  api.js             Frontend fetch wrappers
  components/
    EdgeFeed.jsx      Model-vs-market edge table
    TrendFeed.jsx       MLB streak+matchup trend cards, on-demand prop odds, calibration badges
    Games.jsx             Upcoming games grid (Elo, weather)
    GameDetail.jsx          Per-game odds table + injuries
    ParlaySlip.jsx            Slip, correlation warnings, bet logging
    DailyParlay.jsx             Auto-built +10000 favorites parlay, add-all-to-slip
    BetLog.jsx                    History, CLV, ROI, postmortem breakdown per bet
    Calibration.jsx                 Real hit-rate table across all graded bets
    SportSwitcher.jsx                 NFL/NBA/MLB toggle
    Disclaimer.jsx                      Always-visible honesty banner
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
- **"Vs this pitcher" history**: unlike "vs this team" (built, see above),
  no source for batter-vs-specific-pitcher stats was ever found or verified.
  ESPN's gamecast pages do sometimes show a "career vs this pitcher" box, so
  the data likely exists somewhere in their API, but finding it means the
  same live-diagnostic-script process used throughout this file's history —
  see the git log for `server/mlbData.js` for what that process looks like.
- **Better model**: `elo.js`/`eloBootstrap.js` are the only places that would
  need to change to swap in a stronger model — everything downstream just
  consumes `{homeWinProb, expectedMarginHome, sampleSize}`.
- **Real correlation model**: `parlay.js`'s haircut is intentionally crude;
  a same-game copula or historical same-game-parlay hit-rate table would
  slot in there.
- **Extend calibration to the edge feed's ranking too**: `calibration.js`
  already buckets edge-feed legs by (sport, market, model-probability
  decile) — `getCalibration()` returns them alongside trend buckets. Only
  `trends.js` currently *acts* on its buckets (auto-ranking); wiring
  `edges.js` to blend a calibrated bucket rate into its EV calculation
  would be the equivalent move for the edge feed, left out for now to avoid
  changing what "EV" means there without you asking for it.
- **Verified park orientation**: if you can source a trustworthy per-park
  home-plate-to-outfield azimuth table, `weather.js` already computes wind
  direction in degrees (`windDirectionDeg`) — adding a real "blowing out/in"
  verdict is a matter of comparing that to each park's orientation in
  `parks.js` and is deliberately left as a TODO rather than guessed at.
