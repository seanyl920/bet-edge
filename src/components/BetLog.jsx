import { useEffect, useState } from "react";
import { api } from "../api.js";

function fmtOdds(american) {
  if (american == null) return "—";
  return american > 0 ? `+${american}` : `${american}`;
}

const RESULTS = ["pending", "win", "loss", "push", "void"];

export default function BetLog({ refreshKey }) {
  const [state, setState] = useState({ loading: true, bets: [], summary: null });

  function reload() {
    setState((s) => ({ ...s, loading: true }));
    api.listBets().then(({ bets, summary }) => setState({ loading: false, bets, summary }));
  }

  useEffect(reload, [refreshKey]);

  async function patch(id, body) {
    await api.updateBet(id, body);
    reload();
  }

  async function remove(id) {
    await api.deleteBet(id);
    reload();
  }

  const { summary } = state;

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Bet log</h2>
      </div>

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
            <th></th>
          </tr>
        </thead>
        <tbody>
          {state.bets.map((b) => (
            <tr key={b.id}>
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
                <button className="link" onClick={() => remove(b.id)}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!state.loading && state.bets.length === 0 && <p className="muted">No bets logged yet.</p>}
    </div>
  );
}
