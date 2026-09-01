import { useEffect, useState } from "react";
import { api } from "../api.js";

const TYPE_LABEL = {
  hitStreak: "Hit streak",
  rbiStreak: "RBI streak",
  power: "Power",
  pitcherK: "Strikeouts",
};

function fmtOdds(american) {
  if (american == null) return "—";
  return american > 0 ? `+${american}` : `${american}`;
}

/** Rough implied probability from a single price — NOT devigged (no opposing side to devig against), just context. */
function impliedProb(american) {
  if (american == null) return null;
  return american > 0 ? 100 / (american + 100) : -american / (-american + 100);
}

function TrendCard({ trend, sport, onAddLeg }) {
  const [odds, setOdds] = useState({ loading: false, checked: false, outcomes: [], error: null });

  async function checkOdds() {
    setOdds({ loading: true, checked: false, outcomes: [], error: null });
    try {
      const result = await api.trendPropOdds(sport, trend.eventId, trend.player.name, trend.type);
      setOdds({ loading: false, checked: true, outcomes: result.outcomes ?? [], error: result.available === false ? "No odds key configured" : null });
    } catch (err) {
      setOdds({ loading: false, checked: true, outcomes: [], error: err.message });
    }
  }

  return (
    <div className="trend-card">
      <div className="trend-card-header">
        <span className="badge badge-mid">{TYPE_LABEL[trend.type] ?? trend.type}</span>
        {trend.calibration ? (
          <span className="badge badge-ok" title={`Ranked by your own graded history (n=${trend.calibration.n}), not the heuristic score.`}>
            {(trend.calibration.rate * 100).toFixed(0)}% historically (n={trend.calibration.n})
          </span>
        ) : (
          <span className="badge badge-mid" title="No calibrated history yet for this bucket — ranked by the heuristic score instead.">
            score {trend.score}
          </span>
        )}
      </div>
      <h3>{trend.headline}</h3>
      <div className="muted small">
        {trend.matchup} · {new Date(trend.commenceTime).toLocaleString()}
      </div>

      <div className="trend-context">
        <div>
          <strong>Matchup:</strong> vs {trend.opponent.team}
          {trend.opponent.pitcher ? ` (${trend.opponent.pitcher.name})` : ""} — {trend.matchupLabel}
        </div>
        {trend.pitcherStats && (trend.pitcherStats.era != null || trend.pitcherStats.whip != null) && (
          <div className="muted small">
            Opposing SP: ERA {trend.pitcherStats.era ?? "—"} · WHIP {trend.pitcherStats.whip ?? "—"}
            {trend.pitcherStats.k9 != null ? ` · K/9 ${trend.pitcherStats.k9}` : ""}
          </div>
        )}
        {trend.opponent.teamBattingAvg != null && (
          <div className="muted small">Opposing lineup AVG: {trend.opponent.teamBattingAvg}</div>
        )}
        {trend.park && (
          <div className="muted small">
            {trend.park.name}
            {trend.weather ? ` — ${trend.weather.note}` : ""}
            {trend.park.note ? ` (${trend.park.note})` : ""}
          </div>
        )}
      </div>

      <div className="trend-card-footer">
        {!odds.checked && (
          <button onClick={checkOdds} disabled={odds.loading}>
            {odds.loading ? "Checking…" : "Check odds"}
          </button>
        )}
        {odds.checked && odds.error && <span className="muted small">{odds.error}</span>}
        {odds.checked && !odds.error && odds.outcomes.length === 0 && (
          <span className="muted small">No matching prop line found for this player right now.</span>
        )}
      </div>

      {odds.outcomes.length > 0 && (
        <ul className="trend-odds-list">
          {odds.outcomes.map((o, i) => (
            <li key={i}>
              <span>
                {o.book}: {o.side} {o.point != null ? o.point : ""} {fmtOdds(o.price)}
              </span>
              <button
                onClick={() =>
                  onAddLeg({
                    label: `${trend.player.name} ${o.side}${o.point != null ? ` ${o.point}` : ""} (${TYPE_LABEL[trend.type]})`,
                    eventId: trend.eventId,
                    matchup: trend.matchup,
                    market: trend.type,
                    selection: `${o.side}${o.point != null ? ` ${o.point}` : ""}`,
                    americanOdds: o.price,
                    trueProb: impliedProb(o.price),
                    sport,
                    commenceTime: trend.commenceTime,
                    // Snapshot for later grading (see postmortem.js) — what the
                    // trend actually claimed at bet time, so "what went right/wrong"
                    // has something concrete to compare against.
                    context: {
                      kind: "trend",
                      trendType: trend.type,
                      playerId: trend.player.id,
                      playerName: trend.player.name,
                      streakValue: trend.streakValue,
                      matchupLabel: trend.matchupLabel,
                      score: trend.score,
                      propSide: o.side,
                      propPoint: o.point,
                    },
                  })
                }
              >
                + Slip
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function TrendFeed({ sport, onAddLeg }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: null, data: null });
    api
      .trends(sport)
      .then((data) => !cancelled && setState({ loading: false, error: null, data }))
      .catch((err) => !cancelled && setState({ loading: false, error: err.message, data: null }));
    return () => {
      cancelled = true;
    };
  }, [sport]);

  const { loading, error, data } = state;

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Trends</h2>
      </div>

      <p className="muted small">
        Score is a heuristic count of stacked factors (streak length + matchup quality) — <strong>not</strong> a
        win probability. Once a (trend type, score) bucket has {data?.calibrationMinSample ?? 15}+ graded bets in
        your log (Bet log tab → Analyze), this ranks by that bucket's real hit rate instead — shown as a green
        "% historically" badge instead of the score badge. See the Calibration tab for the full table. Weather is
        shown for context only; this app doesn't claim to know which way the wind blows relative to any specific
        park's layout (see README).
      </p>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {data?.note && <p className="muted">{data.note}</p>}

      {data && !data.note && (
        <p className="muted small">
          Scanned {data.gamesScanned} game(s) in the next 36h. Thresholds: hit streak ≥{data.thresholds?.hitStreak},
          RBI streak ≥{data.thresholds?.rbiStreak}, HR streak ≥{data.thresholds?.hrStreak} (or {data.thresholds?.hrIn10}+
          in last 10), K streak ≥{data.thresholds?.kStreak} starts.
        </p>
      )}

      {data?.trends?.length === 0 && !data.note && (
        <p className="muted">No trends clear the thresholds right now — check back closer to game time.</p>
      )}

      <div className="trend-grid">
        {data?.trends?.map((t, i) => (
          <TrendCard key={i} trend={t} sport={sport} onAddLeg={onAddLeg} />
        ))}
      </div>
    </div>
  );
}
