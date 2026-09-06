import { Fragment, useEffect, useState } from "react";
import { api } from "../api.js";

function fmtOdds(american) {
  if (american == null) return "—";
  return american > 0 ? `+${american}` : `${american}`;
}

const RESULTS = ["pending", "win", "loss", "push", "void"];
const SETTLED = new Set(["win", "loss", "push"]);

function PostmortemRow({ bet, colSpan }) {
  if (!bet.postmortem) return null;
  return (
    <tr className="postmortem-row">
      <td colSpan={colSpan}>
        <div className="postmortem">
          <div className="muted small">{bet.postmortem.summary}</div>
          <ul>
            {bet.postmortem.legs.map((leg, i) => (
              <li key={i} className={leg.hit === true ? "pos" : leg.hit === false ? "neg" : "muted"}>
                <strong>
                  {leg.hit === true ? "✓" : leg.hit === false ? "✗" : "?"} {leg.label}
                </strong>
                <div className="small">{leg.note}</div>
              </li>
            ))}
          </ul>
        </div>
      </td>
    </tr>
  );
}

export default function BetLog({ refreshKey }) {
  const [state, setState] = useState({ loading: true, bets: [], summary: null });
  const [expanded, setExpanded] = useState(() => new Set());
  const [analyzing, setAnalyzing] = useState(null);
  const [capturing, setCapturing] = useState(null);
  const [captureError, setCaptureError] = useState(null);
  // Confirmed real gap (external review, Sept 2026): load/edit/delete/analyze
  // all called their api.* method with no .catch (load) or no try/catch at
  // all (edit, delete, analyze) — a failed request (network error, a 400
  // from the server) became an unhandled promise rejection that the UI
  // never showed the user anything about. Worse for load specifically: a
  // failure left `loading: true` forever, since the .then() that would
  // flip it to false never ran. One shared error slot for these four
  // (captureClose already has its own row-scoped captureError above).
  const [actionError, setActionError] = useState(null);

  function reload() {
    setState((s) => ({ ...s, loading: true }));
    api
      .listBets()
      .then(({ bets, summary }) => setState({ loading: false, bets, summary }))
      .catch((err) => {
        setState((s) => ({ ...s, loading: false }));
        setActionError(`Couldn't load the bet log: ${err.message}`);
      });
  }

  useEffect(reload, [refreshKey]);

  async function patch(id, body) {
    try {
      await api.updateBet(id, body);
      setActionError(null);
      reload();
    } catch (err) {
      // Reload deliberately skipped here — the edit didn't take, so
      // re-fetching would just show the same (unedited) row again and the
      // error message would explain why nothing visibly changed.
      setActionError(`Couldn't save that change: ${err.message}`);
    }
  }

  async function remove(id) {
    // Confirmed real gap: this used to delete immediately on click, with
    // no confirmation — a single misclick permanently removed a logged
    // bet (deleteBet has no undo). A native confirm() is enough here; this
    // app has no modal/dialog component elsewhere to match.
    if (!window.confirm("Delete this bet? This can't be undone.")) return;
    try {
      await api.deleteBet(id);
      setActionError(null);
      reload();
    } catch (err) {
      setActionError(`Couldn't delete that bet: ${err.message}`);
    }
  }

  async function analyze(id) {
    setAnalyzing(id);
    try {
      await api.analyzeBet(id);
      setActionError(null);
      setExpanded((s) => new Set(s).add(id));
      reload();
    } catch (err) {
      setActionError(`Couldn't analyze that bet: ${err.message}`);
    } finally {
      setAnalyzing(null);
    }
  }

  async function captureClose(id) {
    setCapturing(id);
    setCaptureError(null);
    try {
      await api.captureClose(id);
      reload();
    } catch (err) {
      setCaptureError({ id, message: err.message });
    } finally {
      setCapturing(null);
    }
  }

  function toggleExpanded(id) {
    setExpanded((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const { summary } = state;

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Bet log</h2>
      </div>

      {actionError && <p className="error">{actionError}</p>}

      {summary && (
        <div className="summary-strip">
          <div>
            <div className="stat">{summary.totalBets}</div>
            <div className="muted small">bets logged</div>
          </div>
          <div>
            <div className="stat">${summary.totalStaked}</div>
            <div className="muted small">staked (settled)</div>
          </div>
          <div>
            <div className={`stat ${summary.profit >= 0 ? "pos" : "neg"}`}>
              {summary.profit >= 0 ? "+" : ""}
              ${summary.profit}
            </div>
            <div className="muted small">profit</div>
          </div>
          <div>
            <div className="stat">{summary.roiPct != null ? `${summary.roiPct}%` : "—"}</div>
            <div className="muted small">ROI</div>
          </div>
          <div>
            <div className="stat">{summary.avgClvPct != null ? `${summary.avgClvPct}%` : "—"}</div>
            <div className="muted small">avg CLV</div>
          </div>
        </div>
      )}

      <table className="bet-table">
        <thead>
          <tr>
            <th>Placed</th>
            <th>Matchup</th>
            <th>Selection</th>
            <th>Odds</th>
            <th>Stake</th>
            <th>Closing odds</th>
            <th>CLV</th>
            <th>Result</th>
            <th>Postmortem</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {state.bets.map((b) => (
            <Fragment key={b.id}>
              <tr>
                <td>{new Date(b.placedAt).toLocaleDateString()}</td>
                <td>{b.matchup}</td>
                <td>{b.selection}</td>
                <td>{fmtOdds(b.americanOdds)}</td>
                <td>${b.stake}</td>
                <td>
                  <input
                    type="number"
                    className="inline-input"
                    placeholder="—"
                    defaultValue={b.closingAmericanOdds ?? ""}
                    onBlur={(e) =>
                      e.target.value !== "" &&
                      patch(b.id, { closingAmericanOdds: Number(e.target.value) })
                    }
                  />
                  <button
                    className="link"
                    title="Capture the current best price across books as an approximate closing line — call this close to first pitch, not after."
                    disabled={capturing === b.id}
                    onClick={() => captureClose(b.id)}
                  >
                    {capturing === b.id ? "…" : "capture"}
                  </button>
                  {captureError?.id === b.id && <div className="error small">{captureError.message}</div>}
                </td>
                <td className={b.clvPct > 0 ? "pos" : b.clvPct < 0 ? "neg" : ""}>
                  {b.clvPct != null ? `${b.clvPct}%` : "—"}
                </td>
                <td>
                  <select value={b.result} onChange={(e) => patch(b.id, { result: e.target.value })}>
                    {RESULTS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {SETTLED.has(b.result) ? (
                    <div className="postmortem-actions">
                      <button onClick={() => analyze(b.id)} disabled={analyzing === b.id}>
                        {analyzing === b.id ? "…" : b.postmortem ? "Re-analyze" : "Analyze"}
                      </button>
                      {b.postmortem && (
                        <button className="link" onClick={() => toggleExpanded(b.id)}>
                          {expanded.has(b.id) ? "Hide" : "Show"}
                        </button>
                      )}
                    </div>
                  ) : (
                    <span className="muted small">grade to analyze</span>
                  )}
                </td>
                <td>
                  <button className="link" onClick={() => remove(b.id)}>
                    ✕
                  </button>
                </td>
              </tr>
              {expanded.has(b.id) && <PostmortemRow bet={b} colSpan={10} />}
            </Fragment>
          ))}
        </tbody>
      </table>
      {!state.loading && state.bets.length === 0 && <p className="muted">No bets logged yet.</p>}
    </div>
  );
}
