import { Fragment, useEffect, useState } from "react";
import { api } from "../api.js";

function fmtOdds(american) {
  if (american == null) return "—";
  return american > 0 ? `+${american}` : `${american}`;
}
function pct(x) {
  return x == null ? "—" : `${(x * 100).toFixed(2)}%`;
}

const PROB_SOURCE_LABEL = {
  "elo-blended": "Elo (blended w/ market)",
  calibration: "your graded history",
  devig: "devigged prop line",
};

export default function DailyParlay({ onAddLeg }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [regenerating, setRegenerating] = useState(false);

  function load() {
    setState((s) => ({ ...s, loading: true }));
    api
      .dailyParlay()
      .then((data) => setState({ loading: false, error: null, data }))
      .catch((err) => setState({ loading: false, error: err.message, data: null }));
  }

  useEffect(load, []);

  async function regenerate() {
    setRegenerating(true);
    try {
      const data = await api.regenerateDailyParlay();
      setState({ loading: false, error: null, data });
    } catch (err) {
      setState((s) => ({ ...s, error: err.message }));
    } finally {
      setRegenerating(false);
    }
  }

  function addAllToSlip() {
    for (const leg of data.legs) {
      onAddLeg({
        label: leg.label,
        eventId: leg.eventId,
        matchup: leg.matchup,
        market: leg.market,
        selection: leg.selection,
        americanOdds: leg.americanOdds,
        trueProb: leg.trueProb,
        sport: leg.sport,
        commenceTime: leg.commenceTime,
        context: { kind: leg.source === "trend" ? "trend" : "edge" },
      });
    }
  }

  const { loading, error, data } = state;

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Daily longshot parlay</h2>
        <button onClick={regenerate} disabled={regenerating}>
          {regenerating ? "Building…" : "Regenerate"}
        </button>
      </div>

      <p className="muted small">
        Built once per day from today's shortest-priced ("favorite") plays across the edge feed and MLB
        trends, stacked to approximately <strong>+{data?.targetAmericanOdds ?? 10000}</strong>. This is a
        recreational construct, not a value bet — <strong>stacking favorites into a big multiplier does not
        create positive EV.</strong> Each leg may be reasonable on its own; the combined probability of every
        leg hitting is genuinely low, and the numbers below are shown straight, not dressed up. MLB legs used
        a bounded number of real-money player-prop lookups to build this (not on every trend, to protect your
        Odds API quota).
      </p>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}

      {data && data.legs.length === 0 && (
        <p className="muted">{data.note ?? "No priced legs available today."}</p>
      )}

      {data && data.legs.length > 0 && (
        <>
          <div className="slip-summary">
            <div className="slip-summary-row">
              <span>Combined</span>
              <span>
                {fmtOdds(data.combined.combinedAmericanOdds)} · {pct(data.combined.naive.trueProb)} ·{" "}
                {(data.combined.naive.ev * 100).toFixed(1)}% EV (naive)
              </span>
            </div>
            {data.combined.correlationAdjusted && (
              <div className="slip-summary-row warn">
                <span>Correlation-adjusted</span>
                <span>
                  {pct(data.combined.correlationAdjusted.trueProb)} ·{" "}
                  {(data.combined.correlationAdjusted.ev * 100).toFixed(1)}% EV
                </span>
              </div>
            )}
            {data.note && <p className="warning-note">⚠ {data.note}</p>}
          </div>

          <table className="edge-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Matchup</th>
                <th>Pick</th>
                <th>Odds</th>
                <th>Est. prob</th>
              </tr>
            </thead>
            <tbody>
              {data.legs.map((leg, i) => (
                <Fragment key={i}>
                  <tr>
                    <td>
                      <span className={`badge ${leg.source === "trend" ? "badge-mid" : "badge-ok"}`}>{leg.source}</span>
                    </td>
                    <td>
                      {leg.matchup}
                      <div className="muted small">{leg.sport?.toUpperCase()}</div>
                    </td>
                    <td>
                      {leg.label}
                      {leg.source === "trend" && <div className="muted small">player prop, not a team total</div>}
                    </td>
                    <td>{fmtOdds(leg.americanOdds)}</td>
                    <td>
                      {pct(leg.trueProb)}
                      <div className="muted small">{PROB_SOURCE_LABEL[leg.probSource] ?? leg.probSource}</div>
                    </td>
                  </tr>
                  {leg.reason && (
                    <tr className="daily-parlay-reason-row">
                      <td colSpan={5} className="muted small">
                        Why: {leg.reason}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>

          <button className="primary" onClick={addAllToSlip}>
            Add all {data.legs.length} legs to slip
          </button>
        </>
      )}
    </div>
  );
}
