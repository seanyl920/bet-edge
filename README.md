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

## Known-issue history

This app's honesty is only as good as what's actually been checked, so when
something turns out to be wrong, it goes here — not just fixed silently.

- **The daily parlay's reported EV was meaningless for every trend leg, for
  as long as this feature existed.** `dailyParlay.js` set a trend leg's
  probability to `1 / decimalOdds` — the odds' own vigged implied
  probability — then fed that into the same EV formula the app uses
  everywhere else to mean "how good is this bet." `expectedValue(1/d, d)` is
  *always exactly 0*, by construction, regardless of the actual legs chosen —
  which is why every daily parlay ever generated reported precisely "0.0%
  EV." It looked like a real (if unexciting) number; it was actually
  guaranteed to be zero no matter what. Fixed: a trend leg's probability now
  comes from this app's own calibrated hit rate for that bucket when one
  exists (real empirical data, not a market number at all), or a properly
  devigged Over/Under pair when it doesn't — and a leg is dropped from the
  daily parlay entirely rather than falling back to the vigged number that
  caused this. Caught by an external code review that read the source
  directly rather than trusting this README, which is exactly the kind of
  check this project depends on.
- **The daily parlay rolled over at 7-8pm US Eastern, not midnight.** Its
  "once per day" boundary used `new Date().toISOString().slice(0,10)` — UTC
  midnight — which lands in the middle of a real evening MLB slate for a US
  user. Fixed to use the local calendar day (hardcoded to America/New_York;
  see `dailyParlay.js`).
- **The devigged market consensus included the exact book being bet into**,
  a mild circularity that shrunk the apparent edge inconsistently. Switched
  from mean to median across books (`edges.js`), which blunts most of one
  book's pull on its own; full exclusion of the bet's own book was judged
  not worth the added complexity for the remaining benefit.
- **A missing per-game date from ESPN could silently produce a wrong
  streak.** `mlbData.js`'s merged game log sorted by `new Date(date ?? 0)` —
  a null date (that field is explicitly best-effort) sorted to "oldest,"
  which could bump the *actual* most recent game out of position and let an
  older game get read as "today's." No error, just a confident-looking
  streak computed on a misordered log. Fixed: games with no date are
  excluded from a player's log entirely (logged via `[mlbData]` warn) rather
  than guessed at — a shorter, correctly-ordered log beats a complete,
  possibly-wrong one.
- **Evening games could never grade, permanently.** Same UTC-vs-local root
  cause as the daily-parlay rollover bug above, but a worse consequence:
  `postmortem.js` queried ESPN for the game's final score using a UTC-sliced
  date, so any game with a commence time past 8pm ET resolved to the *next*
  calendar day — a day that game isn't on. The leg came back "not final yet"
  and would return the exact same wrong answer on every future re-analyze,
  forever. Since most MLB games are evening games, this meant most bets
  silently never fed the calibration loop the whole feedback-loop section
  above describes. Fixed by extracting the local-day logic
  (`dateUtil.js`, shared with the daily parlay) and using it in
  `postmortem.js` too.
- **The Trends feed's `hoursAhead: 36` window never actually reached
  tomorrow.** `getScoreboard(sport)` called with no `dates` param returns
  only ESPN's default "today" window — so the 36-hour filter downstream had
  nothing beyond today to filter in the first place. Fixed: `trends.js` now
  fetches today's and tomorrow's dates explicitly and merges them before
  applying the time-window filter.
- **A per-game fetch to an endpoint that had never once worked.**
  `trends.js` called the separate, never-verified `/overview` endpoint for
  every opposing starter's ERA/WHIP/K9 — but every live run this app has
  seen showed "WHIP —" on every card (ERA was always separately overridden
  by the confirmed-working boxscore source). Dropped the call entirely
  rather than keep paying for a fetch that has never once returned real
  data; ERA (the only field actually used in scoring) is unaffected.
- **Closing-line capture was fully manual, and a half-built auto-capture
  function sat unused.** `oddsApi.js` had `getEventOddsSnapshot()`, labeled
  "historical/closing snapshot" — but nothing called it, and its URL was
  actually the *live* per-event odds endpoint, not a real historical-odds
  product (a separate, likely paid tier this app was never wired to use).
  Removed it and built `clv.js` + a "capture" button in the Bet log instead:
  on click, it fetches the *current* best price across books for that leg's
  exact selection and stores it as the closing line. This is a real
  approximation, not textbook CLV — proper CLV compares your price to the
  *same book's* closing price, but a leg's snapshot never recorded which
  book it was placed at, so "best price across books, captured close to
  first pitch" is what's actually captured. Only works for single-leg bets;
  a parlay doesn't have one clean closing price the way a straight bet does.

All five above caught by a second pass of the same external code review
that found the first six — again, every claim verified against the actual
source before being accepted, not taken on faith.

- **A team's home and away spread lines from different books could get
  paired into one nonsense line.** `edges.js` picked the "modal" home point
  and the modal away point independently across all books, then treated
  them as one market — but different books don't always quote symmetric
  home/away lines (e.g. home -3.5 at one book, away +3 at another), so the
  two independently-most-common points weren't necessarily from the same
  actual market. Fixed: `modalSpreadPair()` now finds the most common
  *home+away pair as quoted by the same book*, so the line paired against
  is one a book actually offered, not a mix-and-match of two.
- **The same-game correlation "haircut" pushed probability the wrong way
  for the one relationship it could have gotten exactly right.** The old
  `parlay.js` multiplied every same-game combination's naive probability by
  a flat 0.85, regardless of which markets were involved — but a team's own
  moneyline and spread in the same game aren't just "correlated," one
  strictly implies the other (a favorite covering implies winning outright;
  an underdog winning outright implies covering any positive spread), so
  their real joint probability is `min(p_ml, p_spread)`, not naive
  multiplication shrunk by an arbitrary 15%. For a typical pair that's
  *higher* than the naive number, not lower — the flat haircut had the
  direction backwards for exactly the case this app could prove. Fixed:
  `parlay.js` now computes the exact joint probability for a same-team
  moneyline+spread pair via `min()`, and drops the haircut for every other
  same-game combination (whose real direction isn't provable) in favor of a
  plain warning instead of a fabricated number.
- **Overlapping bet-log writes could race and silently drop a write.**
  `betlog.js`'s add/update/delete each did read-whole-file →
  modify → write-whole-file with no serialization — two requests close
  together (e.g. grading a bet, which triggers an automatic postmortem
  write right after) could both read the same pre-mutation state and the
  later write would clobber the earlier one. A crash mid-write could also
  leave truncated, unreadable JSON. Fixed: every mutation now queues behind
  the previous one via an in-process promise-chain mutex (`serialize()` —
  sufficient here since this app only ever runs one server process), and
  writes go to a temp file that's atomically renamed over the real one, so
  a reader only ever sees a fully-old or fully-new file.
- **Bet log routes accepted unvalidated input.** Stake, American odds, and
  `result` on add/update had no validation — a negative stake, a
  zero/non-numeric odds value, or an arbitrary `result` string would be
  written straight into the log and quietly corrupt downstream math (ROI,
  ✓/✗ grading, calibration buckets). Fixed: `betlog.js` now validates stake
  (finite, ≥ 0), American odds (finite, nonzero) and `result` (one of
  `pending`/`win`/`loss`/`push`/`void`) before any write, rejecting bad
  input with a clear 400 instead of persisting it.
- **A voided bet counted as "pending" forever.** `betLogSummary()` only
  recognized `win`/`loss`/`push` as settled, so a `void` result (money
  back, nothing at risk) never left the pending count even though it's a
  finished bet. Fixed: summary now tracks `financial` results
  (win/loss/push — affect staked/profit/ROI) and `finalized` results
  (those plus void — affect the settled/pending split) separately, and
  reports a `voidBets` count.
- **The API accepted requests from any origin, and a client could write
  its own fabricated `postmortem`.** `index.js` had `app.use(cors())` with
  no restriction — any page in any tab could call this app's routes with
  the browser's ambient session — and the `PATCH /api/bets/:id` route
  forwarded `req.body` straight into `updateBet()`, so a client could set
  `postmortem` directly even though it's meant to be a server-computed
  field that feeds the calibration engine. Fixed: CORS is now restricted
  to the frontend's own origin (`http://localhost:5173` by default,
  configurable via `CORS_ORIGIN`), and the PATCH route strips any
  client-supplied `postmortem` before it reaches `updateBet()` — confirmed
  by sending a request with a fabricated `postmortem` and checking the
  stored bet still had `postmortem: null`. This app still has no
  authentication at all (see Honesty & limits) — the CORS fix keeps a
  random web page from silently using your browser to hit the API, it
  doesn't turn this into a multi-user-safe service.

All six above caught by a third pass of the same external code review, and
each one verified directly against the source and, where practical, against
a running server (a numeric test confirming `coverProbHome + coverProbAway
== 1` for the spread-pairing fix; a concurrent-write test firing 20
simultaneous `addBet()` calls and confirming all 20 landed; a live `curl`
against a running instance confirming the CORS header and the stripped
`postmortem`) before being accepted, not taken on faith.

- **The same player's same streak could show up twice, for two different
  upcoming games, with the exact same number.** On a getaway day (a team's
  home series ends and a road series against a different opponent starts
  the very next day), a player can have two real games inside the Trends
  feed's "today + tomorrow" window. Each game got its own trend card, but
  the streak/stat value behind both is one snapshot taken right now — it
  isn't advanced for whichever game happens first, so the later game's card
  showed the same "N straight games" as the sooner one even though it'll
  actually be different (extended, or broken) by the time that later game
  is actually played. Reported by the user noticing the same player's hit
  streak listed against two different opponents. Fixed: `trends.js` now
  keeps only the soonest upcoming game's trend per player+trend-type;
  different trend types for the same player and game (e.g. a hit streak
  and a power trend together) still both show, since those aren't the same
  stale-number problem.
- **Probable-pitcher lookup broke entirely — every game showed "unknown"
  matchup context.** `getProbablePitchers()` read the starting pitcher out
  of the pregame boxscore's "pitching" stat category — confirmed working
  when originally built, but a live check in September 2026 showed every
  team's boxscore category present with 0 athletes for games still hours
  from first pitch (ESPN evidently stopped populating that pregame, or
  moved when it does). Re-diagnosed live: there's now a dedicated
  `header.competitions[0].competitors[*].probables[0]` field that *is*
  populated this early, and it carries `homeAway` directly (no more
  cross-referencing `data.rosters`) plus the starter's season ERA *and*
  WHIP right there — an upgrade over the old source, which never had WHIP
  at all (every trend card showed "WHIP —", see the entry below this one).
  Fixed: `getProbablePitchers()` rewritten around the new field; verified
  against the exact live shape (a mocked payload matching the diagnostic
  output) plus empty/missing-data edge cases.
- **A wall of "no statistics categories found" warnings looked like the
  batter-gamelog endpoint was broken. It wasn't.** Live diagnostics on 5 of
  the players actually triggering the warning (across 5 different teams)
  showed a clear, boring explanation: 2 had a real gamelog for 2025 but
  nothing yet in 2026 (hadn't been called up this season), and the other 3
  were literally every team's lowest-usage roster spot — a third-string
  catcher — with nothing in *either* season. `getTeamBatters()` lists the
  *whole* roster, not just regulars, and September 1's roster expansion had
  just added a batch of players with little-to-no MLB time right before
  this was reported — so the underlying data was correct, only the log
  message was misleading (it reads like an error for what's actually a
  routine "this player hasn't played" case). Fixed: `parseGameLog()` now
  distinguishes the confirmed "genuinely zero games" response shape
  (exactly `{filters: [...]}`, nothing else) from a truly unexpected one —
  only the latter still warns. Verified against both shapes plus a fully
  empty `{}` response (caught in my own test: an early version of this fix
  would have silently swallowed *that* case too, which should still warn —
  a response with literally nothing in it is a real failure signal, not
  the confirmed "no games" shape).

All three above found via live diagnostic scripts run on the user's own
machine (this app's sandbox has no outbound network access to ESPN) after
the user reported a wall of `[mlbData]` warnings in their server terminal —
six rounds of "run this script, paste the output" to trace the real current
shape of two ESPN endpoints before writing a single line of fix, the same
process this project has used for every ESPN reverse-engineering problem
from the start.

- **The strikeout-prop trend's matchup label used team batting AVG as a
  proxy for "strikes out a lot," when a direct strikeout rate was sitting
  right there unused.** The user pointed out that for a strikeout prop,
  the opposing lineup's actual K rate is much more relevant than their
  batting average — a low-average team isn't necessarily a high-strikeout
  one (it can get there by weak contact instead of whiffing). Correct:
  `getTeamBattingContext()` was already fetching a `strikeouts` field, but
  nothing ever used it. Fixed: it now also fetches plate appearances and
  computes a real K% (strikeouts / PA), and `pitcherKTrends()`'s matchup
  label and score bonus are keyed off that instead of AVG (AVG is still
  shown alongside it for context). Found a real bug while wiring this up:
  the old `strikeouts` fetch used a whole-tree search for either "SO" or
  "K", and a team's own stats response carries *both* — "SO" under the
  batting category (the batters' own strikeouts, what this needs) and "K"
  under pitching (their pitching staff's strikeouts, the wrong number
  entirely). It happened to read correctly only because ESPN's response
  lists the batting category first — correct by luck, not by design, and
  one response reordering away from silently reporting the wrong side.
  Fixed to scope the search explicitly to the batting category. Verified
  against the real confirmed response shape with a mock that gives
  batting-SO and pitching-K deliberately different values, confirming the
  right one is picked.

- **Almost every edge-feed pick (NFL and MLB both) had a `null` model
  probability, so the daily parlay could never find enough favorites to
  build from — reported by the user as "it's only putting the one guy in
  the daily parlay."** Root cause: `EloEngine.getRating()` fell back to
  `BASE_RATING` only for a *missing* entry (`?? BASE_RATING`, which
  doesn't catch an entry that's actually present but `NaN`). If a single
  game ever got applied with a non-finite score — or the season-carryover
  seed computed one from a corrupted prior rating — that team's rating
  became `NaN` and stayed `NaN` forever; every future opponent's updated
  rating was then `NaN` too, and every team *they* played after that, and
  so on. Over a season this can spread from one bad data point to nearly
  the entire league, which is exactly what live diagnostics showed: real
  edges with valid market odds but `modelProb: null` (a rounded `NaN`)
  across both NFL, at a fresh season boundary where carryover had just
  run, and MLB, deep in-season — different Elo states, same underlying
  contamination pattern. Found via the same live-diagnostic-then-fix loop
  as the ESPN issues above, but this one didn't need ESPN's actual
  response shape — the `[dailyParlay]` logging added investigating this
  same report showed real market odds with `modelProb=null`, which was
  enough to trace straight to `elo.js` without any live network access.
  Fixed in three places: `getRating()` now uses `Number.isFinite()`
  instead of `??`, so a corrupted entry self-heals to `BASE_RATING`
  instead of propagating; `applyResult()` now rejects a non-finite score
  outright (with a warning naming the event) instead of computing a `NaN`
  delta from it; and `eloBootstrap.js`'s carryover seeding requires a
  finite prior rating before using it, skipping (with a warning) a `NaN`
  one instead of seeding a team's very first rating of the season with
  it. Verified with a script exercising all three guards together
  (a normal game, a rejected bad-score game, a team with a directly
  pre-corrupted rating self-healing, and confirming it no longer spreads
  to whoever plays it next) plus an isolated test of the carryover-seed
  guard. Caught a bug in my own first version of the score guard while
  writing that test: `Number(null)` is `0`, not `NaN` — coercing a
  missing score straight through `Number()` would have silently turned a
  missing score into a real 0-0 game instead of rejecting it; fixed to
  treat `null`/`undefined` as invalid before coercion.

- **The actual root cause, one level further down: `getTeamSchedule()` and
  `getScoreboard()` share one event parser (`normalizeEvent()` in
  `espn.js`), and it had been reading a completed game's score wrong from
  the start.** The NaN-contamination guards above did their job and
  immediately turned up something bigger: with bad scores now rejected
  instead of silently corrupting ratings, *every single completed game* —
  hundreds of them, across NFL and MLB both — was being rejected. A live
  diagnostic on the raw ESPN response confirmed why: a competitor's score
  on this endpoint is an object, `{ value: 4, displayValue: "4" }`, not a
  bare number. The old code did `Number(home.score)` directly — coercing
  that whole object (via its default `toString()`, `"[object Object]"`) to
  `NaN` every single time, for every completed game, on every sport, since
  this line was written. Because `normalizeEvent()` is the one shared
  parser behind both endpoints, this wasn't just an Elo bug: `postmortem.js`
  computes `event.home.score - event.away.score` to grade edge-feed legs
  from the same field, so moneyline/spread bet grading was silently
  affected too (an always-`NaN` margin). Fixed: `extractScore()` now reads
  `.value` off the object shape (falling back to treating the input as a
  bare number, in case some other endpoint or context differs). Verified
  against the exact confirmed live shape plus null/malformed/bare-number
  cases. This is what the NaN-contamination fix above was actually
  investigating when it surfaced this — the guards stay in place regardless
  (defense in depth: they'd still catch a similarly-shaped bug in a
  different field tomorrow), but this is the fix that makes real Elo
  ratings, real edges, and real postmortem grading start happening again
  instead of merely stopping the bleeding.
- **With real edges finally flowing after the fix above, the daily parlay
  started including NFL games a full week out** (reported by the user:
  games "don't start until the 9th" showing up in a parlay meant to
  resolve today). `getEdgeFeed()` intentionally shows every upcoming
  priced game, not just today's — correct for the main Edge Feed tab,
  where you'd want to browse next week's lines too — but `dailyParlay.js`
  was reusing that same unfiltered list for a construct explicitly framed
  as "today's favorites." The Trends side already had this same-day
  restriction (`gamesInWindow`); the edge-feed side never did. Fixed:
  `edgeCandidates()` now filters to the local calendar day before
  building candidates, the same `localDateKey()` helper used everywhere
  else in this app for exactly this kind of local-day question. Verified
  against the exact reported case (a game 7 days out) plus today-early,
  today-late-crossing-UTC-midnight, and tomorrow cases.
- **With real edges finally flowing, the daily parlay skewed almost
  entirely toward team moneylines/spreads — user's read: "these picks
  dont have research behind them," which prompted checking whether that
  was actually true.** It wasn't a research gap (team picks are real Elo
  output blended with live market odds; trend picks are the same
  streak/matchup engine as the Trends tab, or this app's own calibrated
  hit rate) — it was `assembleTowardTarget()` sorting the whole candidate
  pool by raw probability and filling greedily. A lopsided team favorite
  routinely posts a higher raw probability than a legitimate player prop
  (sportsbooks price props tighter), so team sides structurally won that
  race even when a good, qualifying prop existed. Fixed: reserve up to
  `TREND_RESERVED_LEGS` (3) of the best-qualifying trend legs first,
  before the general fill — `MIN_LEG_PROB` still applies to them, so this
  never forces in a prop that isn't a real favorite, it only stops a real
  one from losing a probability race it didn't need to be in. Verified
  with a candidate pool of 20 team favorites all priced higher than 2
  qualifying trend legs — confirmed both trend legs are now included
  (previously would have been crowded out entirely), a 5-trend-candidate
  case correctly caps at the top 3 by probability, and a zero-trend-
  candidate pool behaves identically to before (no regression).

A fourth round of external review, again read against the actual source
before anything was accepted — nine confirmed findings this time, all
reproduced with a fixture before being fixed:

- **Odds could get attached to the wrong game on a doubleheader day.**
  `matchEspnEvent()` matched an Odds API event to an ESPN scoreboard event
  by team names only — on a day when the same two teams play twice, both
  games have identical team names, and `.find()` silently returned
  whichever one happened to come first in the array, regardless of which
  one the odds event's own `commence_time` actually corresponded to. Odds
  for Game 2 could get displayed, priced, and graded against Game 1.
  Fixed: when team names match more than one ESPN event, disambiguate by
  closest start time — and refuse the match (return null) rather than
  guess when the closest candidate isn't clearly closer than the next one
  (within 30 minutes). Reproduced the exact bug live (Game 2's odds
  landing on Game 1) and verified the fix resolves it, plus an
  equidistant-in-time case correctly refuses to guess.
- **A daily-parlay prop's price and its probability could come from two
  different lines.** `trendCandidates()` picked the highest-paying Over
  across every point offered (e.g. Over 0.5, Over 1.5 all mixed together),
  then priced it against a probability averaged across every point too —
  a leg priced at Over 1.5 could get assigned a probability that was
  really part Over-0.5-market. Reproduced with a fixture matching the
  report almost exactly: an Over 1.5 leg at +200 (a real ~32% probability)
  came back assigned ~45%, non-favorite dressed up as a favorite. Fixed:
  `getTrendPropOdds()` now computes a devigged probability per exact
  point (grouping by point first, then by book within that point) and
  attaches it to every outcome; `trendCandidates()` reads `best.trueProb`
  directly instead of a separately-computed, unscoped average. Verified
  against the exact cross-book scenario from the report, plus a
  no-matching-pair case correctly staying null instead of guessing.
- **Calibration mixed winning Under bets into the rate used for Over
  picks.** `trendKey()` bucketed by `(sport, trendType, score)` — never
  the bet's side. Every trend this app *generates* is framed as an Over,
  but a user can manually add an Under from the raw odds list in
  TrendFeed, and once graded it landed in the exact same bucket an Over
  pick would later be ranked against. Reproduced with the report's own
  numbers: 15 graded Under strikeout bets, all wins, produced a bucket
  this app's own Over-side lookup would have happily used. Fixed: the key
  now includes side; the app's own auto-ranking explicitly looks up the
  "over" bucket (the only side it ever generates), so a manually-logged
  Under's history no longer bleeds into it. Verified with a real
  integration test through `betlog.js` + `calibration.js` together — the
  Over-side lookup now correctly returns null while the Under-side lookup
  correctly shows the real 100% rate.
- **A same-game correlation-adjusted EV was computed against a payout
  nobody quotes.** The exact-joint-probability fix from the previous round
  (moneyline+spread pair, `min(p_ml, p_spread)`) is real, but it was still
  priced against `combinedDecimalOdds` — the individual legs' prices
  multiplied together, which is not what any book actually offers for a
  correlated same-game combination (a real same-game-parlay price is set
  by the book specifically to account for the correlation, and is
  normally worse than this naive product for exactly that reason).
  Reproduced the report's own case (a same-team ML+spread pair) and got a
  +72.5% adjusted EV off a price nobody quoted. Fixed: not by inventing a
  combined price this app has no access to, but by labeling it honestly —
  a `payoutIsHypothetical` flag on the result, a warning added to
  `correlationWarnings` (already rendered everywhere `combined` is shown)
  spelling out why, and an inline caption in both the Parlay Slip and
  Daily Parlay UI next to the number itself.
- **Daily-parlay legs lost everything postmortem.js needs to grade them.**
  `DailyParlay.jsx`'s "Add all to slip" sent `context: { kind: "trend" }` or
  `{ kind: "edge" }` and nothing else — none of the player ID, prop
  side/point, team/side/line, or model/market probabilities that
  `EdgeFeed.jsx`/`TrendFeed.jsx` already capture when a leg is added
  manually. A daily-parlay leg logged as a bet could never be properly
  graded. Also found while fixing this: `commenceTime` was never copied
  onto the leg objects at all (only used internally for the same-day
  filter above), which `gradeEdgeLeg()` needs just to know which date to
  ask ESPN for the final score — so even a leg with a real `eventId`
  couldn't have been graded either. Fixed: `dailyParlay.js` now attaches
  the exact same context shape and `commenceTime` the manual-add flows do;
  `addAllToSlip()` just forwards it instead of rebuilding a thinner one.
  Verified the resulting leg objects carry every field `postmortem.js`'s
  grading functions actually read.
- **Manually adding a trend leg from the odds list still forced a
  meaningless 0% EV.** `TrendFeed.jsx` set `trueProb` to `impliedProb(o.price)`
  — that price's own implied probability — so `expectedValue(trueProb,
  that same price)` is exactly 0 by construction, every time. This is the
  identical bug already fixed once for the daily parlay's auto-generated
  legs; it had just quietly resurfaced on the manual-add path, which was
  never touched by that fix. Fixed: now uses this app's own calibration
  (Over side only) or the devigged per-point probability `getTrendPropOdds()`
  now attaches to each outcome (see above) — and when neither is
  available, the "+ Slip" button is disabled with an explanatory tooltip
  instead of silently adding an unpriceable leg.
- **"Matchup history" bets could never grade.** `STAT_FOR_TREND_TYPE` (the
  map from trend type to the game-log stat to check) was missing
  `vsTeamHistory` entirely — a real, offered trend type — so grading it
  always read `game[undefined]` and returned "Actual stat unavailable,"
  regardless of what actually happened. Fixed: added `vsTeamHistory: "H"`
  (it's a hits-based signal, same as hitStreak).
- **A prop landing exactly on a whole-number line was scored a clean loss
  instead of a push.** `evalOverUnder()` used strict `>`/`<`, so 6
  strikeouts against "Over 6" returned `false` — a real loss, not the push
  it actually is. That false loss would then feed calibration.js a fake
  miss. Fixed: an exact tie is now detected separately and graded `hit:
  null` (not counted either way, same as "can't grade yet") with a note
  explicitly saying "push" — not folded into `evalOverUnder`'s return
  value itself, since that stays strictly true/false/null everywhere
  downstream (calibration.js and the bet summary both do truthy checks on
  it, and a truthy `"push"` string would have silently counted as a win).
- **A missing game could get graded using a different game from the same
  day.** `findGameInLog()` fell back to "any game this player had on the
  same calendar day" whenever the leg's `eventId` didn't match anything in
  the log — even though having an `eventId` at all means the specific game
  is known, and not finding it is a real gap, not a reason to guess. On a
  doubleheader day this could silently grade a leg against the wrong
  game's stats. Reproduced exactly that: an unmatched `eventId` with a
  same-day game present in the log returned that other game instead of
  refusing. Fixed: only fall back to date-matching when there's no
  `eventId` at all (an older bet that never captured one) — an eventId
  that doesn't match anything now correctly returns null.

Two of the review's "worth prioritizing" improvements were small and
contained enough to fix alongside the confirmed bugs, rather than deferred:

- **Concurrent requests for the same not-yet-cached key each ran their own
  upstream fetch.** `cached()` only stored a value *after* awaiting `fn()`,
  so three near-simultaneous calls (the review's own repro) made three
  real fetches instead of sharing one — pure waste always, and a real
  problem against The Odds API's tight free-tier quota specifically.
  Fixed: the in-flight *promise* is stored immediately, so concurrent
  callers share it; a rejection still isn't cached (removed on failure, so
  the next call gets a fresh attempt instead of the same error replayed
  for the rest of the TTL). Verified 3 concurrent calls now produce
  exactly 1 upstream fetch, a cached hit still avoids a 4th, and a failed
  first attempt doesn't poison a second, later call.
- **Two concurrent requests could both build a fresh daily parlay at
  once.** `getDailyParlay()` had no locking — two tabs loading the tab at
  the same moment, or a regenerate click racing initial load, could both
  decide nothing was cached yet and both call `build()`, wasting the
  bounded player-prop lookups (the one place in this app that spends Odds
  API credits without an explicit click) twice. Fixed the same way
  `betlog.js` already serializes writes: every call now queues behind the
  previous one, so only one build ever runs at a time, and a call that
  ends up queued behind a same-day build reads that result back instead
  of starting its own.

The remaining improvements from this round (a shared, validated bet-leg
schema across every feed; permanent regression tests and CI; showing
calibration's uncertainty explicitly rather than a bare percentage;
recording which specific sportsbook a bet was placed at for true CLV) are
real, but bigger scope changes than fit in one review-response round — left
as known future work rather than attempted partially.

A fifth round, checking whether the fourth round's fixes actually held up —
two turned out to be incomplete, plus four more findings, all reproduced
with a fixture first:

- **Calibration mixed different betting thresholds together — the previous
  round only separated Over from Under, not which line.** `trendKey()`
  bucketed by `(sport, trendType, side, score)`; score has nothing to do
  with the threshold actually bet. 15 graded "Over 2.5 K" bets and a
  completely different "Over 8.5 K" line could land in the same score band
  and share a rate — reproduced with the report's own numbers, an Over 8.5
  line getting the Over 2.5 bucket's 100% instead of its own real ~19%.
  The fix isn't "add point to the existing key" — that key is legitimately
  used for RANKING a trend before any specific line is even chosen (score
  is a reasonable proxy there), so it has to stay. Added a second, separate
  key scoped to the actual bet identity — `(sport, trendType, side,
  point)` — used only for PRICING a specific line, never for ranking.
  `getTrendPropOdds()` now attaches this real, exact-line calibration to
  each outcome (preferred over the devigged probability, same priority
  order as before, just correctly scoped), so both the daily parlay and a
  manually-added TrendFeed leg get it automatically. Verified with a real
  integration test through betlog.js + calibration.js: the wrong-line
  lookup now correctly returns null while the right-line lookup shows the
  real 100%, and the (unrelated, still legitimate) ranking lookup is
  unaffected.
- **The doubleheader fix from last round stopped working once only one
  game remained.** `disambiguateByTime()` returned a single candidate
  immediately, skipping time validation entirely, on the reasoning that
  "nothing to disambiguate with only one match." But once Game 1 leaves
  `STATUS_SCHEDULED` (it's started), the edge feed's event list can shrink
  to just Game 2 — and if Game 1's odds are still floating around (a
  lagged quote), that "only candidate" sailed through with zero time
  check, matching Game 1's odds onto Game 2. Reproduced exactly that
  live. Fixed: a single candidate now still has to fall within an absolute
  3-hour window of the odds event's own time, not just be the only name
  match. Verified the exact reported case now returns null, plus a
  genuinely-close single candidate and the original multi-candidate
  disambiguation both still work.
- **Adding a leg could log the wrong odds — a race between the slip
  recalculating and the log button staying enabled.** `ParlaySlip.jsx`'s
  combine request had no ordering guard, so adding a leg quickly (2 legs
  then 3) could fire two overlapping requests and let the older response
  overwrite the newer one if it happened to resolve later — and "Log this
  bet" was only ever disabled while actively submitting, not while the
  displayed price was stale or still loading. Reproduced the report's
  case: a 3-leg slip logging at the 2-leg price. Fixed with the standard
  React fix for this — clear the stale price immediately when legs
  change, ignore a response that arrives after a newer request has
  already superseded it, and disable logging (with a "Calculating…"
  label) whenever the current legs don't have a matching price yet.
- **The daily parlay's favorites builder could throw away a real favorite
  in favor of a longshot it was about to reject anyway.** `best` was
  chosen by price alone across every point mixed together, before
  checking eligibility — so a longshot point (Over 8.5 K at a real ~19%)
  could out-pay a genuine favorite on the very same player (Over 2.5 K at
  ~69%), get picked as `best`, then get rejected by the `MIN_LEG_PROB`
  floor downstream — discarding the whole trend even though a real
  favorite existed right next to it. Reproduced with the report's own
  69.2%/18.9% numbers. Fixed: restrict to eligible (favorite) points
  first, then compare price only among those.
- **One trend's odds not matching an event could stop every remaining
  trend from ever being checked — and separately, prop odds for tomorrow's
  games could never be found at all.** `getTrendPropOdds()` returned
  `available: false` whenever it couldn't match an event to an odds
  event — a normal, common outcome unrelated to API key status — but
  `trendCandidates()`'s comment and logic both treated that as "no key
  configured" and `break`s its whole loop, so one ordinary miss silently
  stopped every other candidate from being checked. Reproduced: a valid
  second candidate was never reached. Separately: this function called
  `getScoreboard(sport)` with no date, which is ESPN's today-only default
  — a trend whose game is tomorrow (this app's own trend window spans
  today+tomorrow) could never be matched, ever, regardless of whether real
  odds existed. Fixed: `getTrendPropOdds()` now checks `hasOddsApiKey()`
  explicitly and returns a `reason` (`"no-key"` vs `"event-not-found"`) so
  a caller can actually tell the two apart — `trendCandidates()` only
  breaks on a real no-key result, and continues past an ordinary miss; and
  it now uses the same merged today+tomorrow scoreboard `gamesInWindow`
  already relies on (extracted into a shared `todayAndTomorrowScoreboard()`
  helper) instead of the today-only default. `TrendFeed.jsx`'s "Check
  odds" button also used to always say "No odds key configured" for any
  miss — now says something accurate for each case.
- **The daily parlay's own screen hid same-game correlation warnings the
  server was already generating.** `combineLegs()` returns
  `correlationWarnings` for same-game legs without a provable relationship
  (the naive number could be off in either direction, not just optimistic)
  — `ParlaySlip.jsx` renders these, `DailyParlay.jsx` never did, so a
  warning the server generated was simply invisible on this specific
  screen. Confirmed the server producing one that never reached the
  rendered output. Fixed: renders the same list, the same way.

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
roughly **+10000** — with up to `TREND_RESERVED_LEGS` (3) of the
best-qualifying player-prop legs reserved first, so a lopsided team
favorite (routinely a higher raw probability than even a well-researched
prop, since sportsbooks price props tighter) doesn't crowd every prop out
of a parlay that's supposed to be pulling from both the edge feed and
MLB trends.

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

Each leg's row has a "Why" line underneath it explaining what actually made
this app favor it: for an edge-feed leg, the Elo model's own probability and
sample size alongside the market's consensus and where the two got blended
to; for a trend leg, either its real calibrated hit rate (when this app has
graded enough similar legs) or the streak/matchup context that produced it
plus a note that it's priced off the devigged prop line, not this app's own
model. This is meant as a quick sanity check, not a fresh analysis — cross-
reference it against the actual streak/ERA/matchup numbers shown elsewhere
before trusting it.

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
  flag mispricing, not a precision instrument. (Still true, and still the
  lowest-priority known gap — everything else in this list once had the same
  status until it got fixed; see [Known-issue history](#known-issue-history).)
- **The edge feed blends Elo toward the market, but never fully trusts
  either.** `edges.js`'s EV/Kelly are computed off a probability shrunk
  toward the devigged market consensus (weight scaling with sample size, capped
  at 50% model trust even at a full season — see `blendWithMarket`), not raw
  Elo. Raw Elo is still shown alongside it in the Edge feed table, labeled as
  such, so you can see when the two disagree a lot — that disagreement is
  usually the model being wrong, not the market missing something.
- **Elo carries over between seasons, but the carryover math was never run
  against a live response.** `eloBootstrap.js` seeds each team from
  `0.75 × last-season-final + 0.25 × 1500` rather than a flat 1500 — the
  standard fix for "early-season ratings are noise" — but the `?season=YYYY`
  parameter it depends on was never confirmed live, and "last season" is a
  naive `currentYear - 1` that's likely wrong for NBA/NFL's cross-calendar-year
  seasons. It fails closed (flat 1500, this app's original behavior) rather
  than silently producing bad ratings if the fetch comes back empty — confirm
  it live before trusting April/May edges next season.
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
  file and there's still no authentication — CORS is restricted to the
  frontend's own origin (see Known-issue history), which stops a random web
  page from using your browser to hit the API, but anyone with direct
  network access to the port can still call it. It isn't built for sharing
  bets or data with other people.
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
  betlog.js                           Bet log CRUD (closing line stored manually or via clv.js)
  postmortem.js                         Grades a settled bet's legs against what actually happened
  calibration.js                          Aggregates graded legs into real hit-rate buckets
  clv.js                                    On-demand approximate closing-line capture
  dailyParlay.js                              Auto-builds one +10000 "favorites" longshot parlay per day
  weather.js                           Open-Meteo (NFL/MLB outdoor venues)
  stadiums.js                           NFL stadium coordinates + roof type
  parks.js                               MLB ballpark coordinates + roof type (no orientation/wind-direction claims — see caveats)
  dateUtil.js                              Local-calendar-day helper (UTC's day boundary is wrong for this app's actual usage)
  cache.js                                   In-memory TTL cache
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
- **Real correlation model**: `parlay.js` only proves one relationship
  exactly (a same-team moneyline+spread pair, via `min()`); every other
  same-game combination gets a warning, not a number, because its
  direction isn't provable with what this app has. A same-game copula or a
  historical same-game-parlay hit-rate table would let more of those get a
  real adjustment instead of just a warning.
- **Automated tests + CI/lint**: this project has been validated the whole
  way through by targeted node scripts run ad hoc during development (a
  parlay math check here, a concurrent-write test there — see the
  Known-issue history for specifics) plus manual boot-testing, not a
  standing test suite. Turning the more reusable of those checks into a
  real `test/` directory wired into CI (and adding basic linting) would
  catch a regression automatically instead of relying on the next code
  review to find it.
- **`npm audit` currently reports 5 vulnerabilities (4 moderate, 1 high),
  in two clusters, checked directly rather than taken on a reviewer's
  count.** `esbuild`/Vite (moderate — the dev server can be made to proxy
  requests for any site that gets you to open a malicious page while it's
  running; irrelevant once built, and this is a localhost-only dev tool)
  needs Vite 8.x to clear. `qs`/`body-parser`/Express (the rest, including
  the high one) needs Express 5.x. Both are breaking major-version bumps —
  `npm audit fix` (no `--force`) was tried first and confirmed to change
  nothing at all (even in `--dry-run`) despite npm's own "fix available"
  messaging for the qs cluster, so there's no safe partial fix available
  here, only the two forced upgrades. Not urgent for a localhost-only dev
  tool with no untrusted input reaching either, but worth doing deliberately
  (with the Express route/middleware changes tested, not just installed)
  rather than forced through blind.
- **Record which book a bet was actually placed at**: `clv.js`'s "capture
  close" button approximates CLV using the best price *across* books,
  because a leg's snapshot never records which specific book it was placed
  at (see Known-issue history). Adding a `book` field when a leg is added
  to the slip would let CLV be computed against that same book's closing
  price — the textbook definition — instead of the current approximation.
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
- **One shared, validated bet-leg schema**: `EdgeFeed.jsx`, `TrendFeed.jsx`,
  and `dailyParlay.js` each independently build the `context` blob a leg
  needs for later grading — they agree today (the daily-parlay round of
  fixes made sure of that), but nothing stops them drifting apart again
  the next time one of the three changes, since there's no single source
  of truth or validation for the shape. Worth factoring into one function
  all three call, with real validation (missing/wrong-typed fields
  rejected loudly at the point a leg is added, not discovered later when
  postmortem.js can't grade it).
- **Show calibration's uncertainty, not just a bare percentage**: a bucket
  crossing `MIN_SAMPLE` (15) at "53% over 15 legs" and one at "53% over
  400 legs" currently render identically once both count as "calibrated."
  A confidence interval (even a rough one, e.g. Wilson score) alongside
  the rate would make the difference visible instead of implied.
