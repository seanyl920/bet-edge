import { useEffect, useState } from "react";
import { api } from "../api.js";

function pct(x) {
  return x == null ? "—" : `${(x * 100).toFixed(1)}%`;
}

function fmtOdds(american) {
  if (american == null) return "—";
  return american > 0 ? `+${american}` : `${american}`;
}

function sampleBadge(n, min) {
  if (n < min) return <span className="badge badge-low">thin sample ({n})</span>;
  if (n < min * 3) return <span className="badge badge-mid">{n} games</span>;
  return <span className="badge badge-ok">{n} games</span>;
}

export default function EdgeFeed({ sport, onAddLeg, onSelectGame }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [threshold, setThreshold] = useState(2);

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: null, data: null });
    api
      .edges(sport, threshold / 100)
      .then((data) => !cancelled && setState({ loading: false, error: null, data }))
      .catch((err) => !cancelled && setState({ loading: false, error: err.message, data: null }));
    return () => {
      cancelled = true;
    };
  }, [sport, threshold]);

  const { loading, error, data } = state;

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Edge feed</h2>
        <label className="threshold-control">
          Min EV
          <input
            type="number"
            min="0"
            max="20"
            step="0.5"
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
          />
          %
        </label>
      </div>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}

      {data && !data.oddsAvailable && (
        <p className="muted">
          No <code>ODDS_API_KEY</code> configured — game list and Elo ratings still work below,
          but odds comparison and edge detection are disabled. Get a free key at{" "}
          <a href="https://the-odds-api.com" target="_blank" rel="noreferrer">
            the-odds-api.com
          </a>{" "}
          and add it to <code>.env</code>.
        </p>
      )}

      {data && data.oddsAvailable && data.edges.length === 0 && (
        <p className="muted">
          No edges ≥ {threshold}% EV right now across {data.games.length} upcoming game(s). That's
          normal — real edges are rare. Try lowering the threshold or check back closer to kickoff.
        </p>
      )}

      {data && data.edges.length > 0 && (
        <table className="edge-table">
          <thead>
            <tr>
              <th>Matchup</th>
              <th>Market</th>
              <th>Pick</th>
              <th>Best price</th>
              <th>Model</th>
              <th>Market</th>
              <th>EV</th>
              <th>Kelly ¼</th>
              <th>Sample</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.edges.map((e, i) => (
              <tr key={i}>
                <td>
                  <button className="link" onClick={() => onSelectGame(e.eventId)}>
                    {e.matchup}
                  </button>
                  <div className="muted small">{new Date(e.commenceTime).toLocaleString()}</div>
                </td>
                <td>{e.market}</td>
                <td>
                  {e.team}
                  {e.line != null ? ` ${e.line > 0 ? "+" : ""}${e.line}` : ""}
                </td>
                <td>
                  {fmtOdds(e.americanOdds)} <span className="muted small">({e.book})</span>
                </td>
                <td>{pct(e.modelProb)}</td>
                <td>{pct(e.marketProb)}</td>
                <td className="ev-cell">+{e.evPct}%</td>
                <td>{e.kellyStakePct}%</td>
                <td>{sampleBadge(e.sampleSize, data.minSampleSize)}</td>
                <td>
                  <button
                    onClick={() =>
                      onAddLeg({
                        label: `${e.team}${e.line != null ? ` ${e.line}` : ""} (${e.market})`,
                        eventId: e.eventId,
                        matchup: e.matchup,
                        market: e.market,
                        selection: `${e.team}${e.line != null ? ` ${e.line}` : ""}`,
                        americanOdds: e.americanOdds,
                        trueProb: e.modelProb,
                        sport,
                        commenceTime: e.commenceTime,
                        // Snapshot for later grading (see postmortem.js) — what the
                        // model/market believed at bet time, so we can check it later.
                        context: {
                          kind: "edge",
                          side: e.side,
                          team: e.team,
                          line: e.line ?? null,
                          modelProb: e.modelProb,
                          marketProb: e.marketProb,
                          sampleSize: e.sampleSize,
                        },
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
      )}
    </div>
  );
}
