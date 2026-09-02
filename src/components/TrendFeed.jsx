import { useEffect, useState } from "react";
import { api } from "../api.js";

const TYPE_LABEL = {
  hitStreak: "Hit streak",
  rbiStreak: "RBI streak",
  power: "Power",
  pitcherK: "Strikeouts",
  vsTeamHistory: "Matchup history",
};

function fmtOdds(american) {
  if (american == null) return "—";
  return american > 0 ? `+${american}` : `${american}`;
}

function TrendCard({ trend, sport, onAddLeg }) {
  const [odds, setOdds] = useState({ loading: false, checked: false, outcomes: [], error: null });

  async function checkOdds() {
    setOdds({ loading: true, checked: false, outcomes: [], error: null });
    try {
      const result = await api.trendPropOdds(sport, trend.eventId, trend.player.name, trend.type);
      // Was: always "No odds key configured" whenever available was false —
      // misleading, since that's almost always just "this game's props
      // didn't match an odds event yet" (normal, common), not a real key
      // problem. The server now distinguishes the two.
      const unavailableMessage =
        result.reason === "no-key"
          ? "No odds key configured"
          : "No matching odds event found for this game yet.";
      setOdds({ loading: false, checked: true, outcomes: result.outcomes ?? [], error: result.available === false ? unavailableMessage : null });
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
        {trend.lineupStatus === "confirmed" && (
          <span
            className="badge badge-ok"
            title="ESPN has posted today's real starting lineup, and this player is in it."
          >
            starting{trend.player.battingOrder ? `, batting ${trend.player.battingOrder}` : ""}
          </span>
        )}
        {trend.lineupStatus === "projected" && (
          <span
            className="badge badge-mid"
            title="Today's lineup hasn't posted yet — this is from the full roster, not a confirmed starter. Score is reduced to reflect that."
          >
            lineup not confirmed yet
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
        {(trend.opponent.teamKRate != null || trend.opponent.teamBattingAvg != null) && (
          <div className="muted small">
            {trend.opponent.teamKRate != null && `Opposing lineup K rate: ${trend.opponent.teamKRate}`}
            {trend.opponent.teamKRate != null && trend.opponent.teamBattingAvg != null && " · "}
            {trend.opponent.teamBattingAvg != null && `AVG: ${trend.opponent.teamBattingAvg}`}
          </div>
        )}
        {trend.vsTeamNote && trend.type !== "vsTeamHistory" && (
          <div className="muted small">Also: {trend.vsTeamNote} (this-season sample — see README caveat)</div>
        )}
        {trend.type === "pitcherK" && trend.daysRest != null && (
          <div className="muted small">Days rest: {trend.daysRest}</div>
        )}
        {trend.type === "pitcherK" && trend.workloadNote && (
          <div className="warning-note">⚠ {trend.workloadNote}</div>
        )}
        {trend.savant && (
          <div className="muted small">
            Season {trend.type === "pitcherK" ? "pitching" : "hitting"} profile (Baseball Savant
            {trend.savant.season ? `, ${trend.savant.season}` : ""}
            {!trend.savant.splitByHandedness ? ", not split by handedness" : ""}): K% {trend.savant.kPercent ?? "—"} ·
            BB% {trend.savant.bbPercent ?? "—"} · Whiff% {trend.savant.whiffPercent ?? "—"}
            {trend.savant.barrelRate != null ? ` · Barrel% ${trend.savant.barrelRate}` : ""}
          </div>
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
          {odds.outcomes.map((o, i) => {
            // Was: trueProb = impliedProb(o.price) — that price's OWN implied
            // probability, so expectedValue(trueProb, that same price) is
            // exactly 0 by construction, every time (the same "fake EV"
            // problem this app already fixed once for the daily parlay's
            // auto-generated legs — it had just quietly resurfaced here, on
            // the manually-added path). trends.js now attaches a real
            // devigged probability per outcome, scoped to that exact point
            // (see attachDevigProbs). This app's own calibration is only
            // ever computed for the "Over" side (every trend it generates is
            // framed as one), so it's only used here when the side actually
            // is Over — never borrowed for an Under leg.
            const realProb = o.side === "Over" ? (trend.calibration?.rate ?? o.trueProb) : o.trueProb;
            const disabled = realProb == null;
            return (
              <li key={i}>
                <span>
                  {o.book}: {o.side} {o.point != null ? o.point : ""} {fmtOdds(o.price)}
                </span>
                <button
                  disabled={disabled}
                  title={
                    disabled
                      ? "No reliable probability for this exact line yet — no book offers both sides of it to devig against, and there's not enough calibrated history for it either. Adding it would force a meaningless 0% EV, so it's disabled instead."
                      : undefined
                  }
                  onClick={() =>
                    onAddLeg({
                      label: `${trend.player.name} ${o.side}${o.point != null ? ` ${o.point}` : ""} (${TYPE_LABEL[trend.type]})`,
                      eventId: trend.eventId,
                      matchup: trend.matchup,
                      market: trend.type,
                      selection: `${o.side}${o.point != null ? ` ${o.point}` : ""}`,
                      americanOdds: o.price,
                      trueProb: realProb,
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
            );
          })}
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
