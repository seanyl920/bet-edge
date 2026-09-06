import { useEffect, useState } from "react";
import { api } from "../api.js";

function fmtOdds(american) {
  if (american == null) return "—";
  return american > 0 ? `+${american}` : `${american}`;
}
function pct(x) {
  return x == null ? "—" : `${(x * 100).toFixed(1)}%`;
}

const PROB_SOURCE_LABEL = {
  "elo-blended": "Elo (blended w/ market)",
  calibration: "your graded history",
  devig: "devigged prop line",
  poisson: "Poisson strikeout model",
};

// Answers the review's core math complaint about DailyParlay.jsx's
// favorites-stack (10 legs @ ~60% each compounds to well under 1%
// combined — a lottery ticket, not a confident day). This tab never
// combines anything: every bet here stands on its own real probability,
// price, and EV, ranked by EV — see bestBets.js. Kept alongside (not
// replacing) the old daily parlay, which is still there under "Longshot
// parlay" for the recreational, dressed-up-honestly use case it always
// was — this is the new default landing tab because "what should I bet
// today" is the actual question a decision-oriented tool should open on.
export default function TodaysBets({ onAddLeg }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });

  function load() {
    setState((s) => ({ ...s, loading: true }));
    api
      .bestBets()
      .then((data) => setState({ loading: false, error: null, data }))
      .catch((err) => setState({ loading: false, error: err.message, data: null }));
  }

  useEffect(load, []);

  const { loading, error, data } = state;

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Today's best bets</h2>
        <button onClick={load} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <p className="muted small">
        Every real positive-EV single bet this app found today, across the edge feed and MLB trends —
        ranked by EV, <strong>never combined into a parlay</strong>. Stacking many favorites together (see
        the "Longshot parlay" tab) multiplies their probabilities down to a tiny combined number no matter
        how good each leg looks alone — that's a different, recreational product, not this one. Each bet
        below is meant to be placed on its own, at its own real price. This is still a research tool, not a
        prediction machine — see the disclaimer above; small-sample noise is real, and an EV shown here is a
        lead to research further, not a lock.
      </p>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {data?.note && <p className="muted">{data.note}</p>}

      {data && data.bets.length > 0 && (
        <div className="table-wrap">
          <table className="edge-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Matchup</th>
                <th>Pick</th>
                <th>Odds</th>
                <th>Prob</th>
                <th>EV</th>
                <th>Kelly ¼</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.bets.map((bet, i) => (
                <tr key={i}>
                  <td>
                    <span className={`badge ${bet.source === "trend" ? "badge-mid" : "badge-ok"}`}>{bet.source}</span>
                  </td>
                  <td>
                    {bet.matchup}
                    <div className="muted small">{bet.sport?.toUpperCase()}</div>
                  </td>
                  <td>
                    {bet.label}
                    <div className="muted small">{PROB_SOURCE_LABEL[bet.probSource] ?? bet.probSource}</div>
                  </td>
                  <td>
                    {fmtOdds(bet.americanOdds)} <span className="muted small">({bet.book})</span>
                  </td>
                  <td>{pct(bet.trueProb)}</td>
                  <td className="ev-cell">
                    {bet.evPct >= 0 ? "+" : ""}
                    {bet.evPct}%
                  </td>
                  <td>{bet.kellyStakePct}%</td>
                  <td>
                    <button
                      onClick={() =>
                        onAddLeg({
                          label: bet.label,
                          eventId: bet.eventId,
                          matchup: bet.matchup,
                          market: bet.market,
                          selection: bet.selection,
                          americanOdds: bet.americanOdds,
                          book: bet.book,
                          trueProb: bet.trueProb,
                          sport: bet.sport,
                          commenceTime: bet.commenceTime,
                          context: bet.context,
                        })
                      }
                    >
                      + Slip
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
