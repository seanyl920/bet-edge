import { useEffect, useState } from "react";
import { api } from "../api.js";

function pct(x) {
  return x == null ? "—" : `${(x * 100).toFixed(1)}%`;
}
function brier(x) {
  return x == null ? "—" : x.toFixed(3);
}

// Confirmed real gap (external review, Sept 2026): server/predictionEval.js
// computes real hit-rate/Brier-score numbers off every prediction this app
// actually prices (not just what a user chose to bet — see predictionLog.js)
// on every request to GET /api/predictions/eval, but nothing in the frontend
// ever called it or showed it. This is the one honest, prospective
// evaluation this project can do; it needs a tab, same as any other feed.
export default function PredictionEval() {
  const [state, setState] = useState({ loading: true, error: null, data: null });

  function load() {
    setState((s) => ({ ...s, loading: true }));
    api
      .predictionsEval()
      .then((data) => setState({ loading: false, error: null, data }))
      .catch((err) => setState({ loading: false, error: err.message, data: null }));
  }

  useEffect(load, []);

  const { loading, error, data } = state;

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Model eval</h2>
        <button onClick={load} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <p className="muted small">
        Grades every prediction this app has actually priced (not just what got bet — see the bet log) against
        real outcomes, once they're final. This is deliberately NOT a historical backtest — there's no archive
        of past odds to replay — so a group's <code>n</code> only grows going forward, one real game at a time.
        Groups are split by <code>probSource</code> too: a "devig" prediction (priced off the raw market line)
        and a "calibration" prediction (priced off your own graded history for that exact line) are two
        different methods and are never averaged together here. The "vs market" columns are the fair
        comparison — both this app's own Brier score and the market's, computed on only the predictions where
        both a model and a market probability exist (see the <code>n</code> in that column, which can be
        smaller than the group's total — a comparison built on a handful of matched rows isn't worth much
        either). "Promotable" (see <code>server/modelRegistry.js</code>) is a recommendation, never automatic —
        it only ever suggests that a probSource has enough matched volume and a good enough Brier score to be
        worth manually wiring in as the price a real bet actually uses; nothing here flips that on its own.
      </p>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}

      {data && (
        <p className="muted small">
          {data.totalGraded} of {data.totalLogged} logged predictions graded so far
          {data.totalLogged > data.totalGraded && (
            <>
              {" "}
              (
              {[
                data.ungradedReasons.notFinalOrMissing > 0 && `${data.ungradedReasons.notFinalOrMissing} not final yet`,
                data.ungradedReasons.postStart > 0 && `${data.ungradedReasons.postStart} excluded (recorded after start)`,
                data.ungradedReasons.gradingThrew > 0 && `${data.ungradedReasons.gradingThrew} grading errors`,
                data.ungradedReasons.noLeg > 0 && `${data.ungradedReasons.noLeg} missing leg data`,
              ]
                .filter(Boolean)
                .join(", ")}
              )
            </>
          )}
          .
        </p>
      )}

      {data && data.groups.length === 0 && (
        <p className="muted">Nothing graded yet — this fills in once today's (or a past day's) predictions have real outcomes.</p>
      )}

      {data && data.groups.length > 0 && (
        <div className="odds-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Sport</th>
                <th>Kind</th>
                <th>Market</th>
                <th>Prob source</th>
                <th>n</th>
                <th>Hit rate</th>
                <th>Avg model prob</th>
                <th>Avg market prob</th>
                <th>vs market (n)</th>
                <th>Model Brier</th>
                <th>Market Brier</th>
                <th>Promotable?</th>
              </tr>
            </thead>
            <tbody>
              {data.groups.map((g, i) => (
                <tr key={i}>
                  <td>{g.sport?.toUpperCase()}</td>
                  <td>{g.kind}</td>
                  <td>{g.market}</td>
                  <td>{g.probSource ?? "—"}</td>
                  <td>{g.n}</td>
                  <td className={g.hitRate >= 0.5 ? "pos" : "neg"}>{pct(g.hitRate)}</td>
                  <td>{pct(g.avgPredictedProb)}</td>
                  <td>{pct(g.avgMarketProb)}</td>
                  <td>{g.comparison.n}</td>
                  <td>{brier(g.comparison.modelBrierScore)}</td>
                  <td>{brier(g.comparison.marketBrierScore)}</td>
                  <td title={g.promotion?.reason}>
                    {g.promotion?.promotable ? (
                      <span className="badge badge-ok">yes</span>
                    ) : (
                      <span className="badge badge-mid">no</span>
                    )}
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
