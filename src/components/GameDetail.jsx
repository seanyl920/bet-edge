import { useEffect, useState } from "react";
import { api } from "../api.js";

function fmtOdds(american) {
  if (american == null) return "—";
  return american > 0 ? `+${american}` : `${american}`;
}

const MARKET_LABELS = { h2h: "Moneyline", spreads: "Spread", totals: "Total" };

export default function GameDetail({ sport, eventId, onClose, onAddLeg }) {
  const [odds, setOdds] = useState({ loading: true, error: null, data: null });
  const [injuries, setInjuries] = useState({ loading: true, data: null });

  useEffect(() => {
    let cancelled = false;
    setOdds({ loading: true, error: null, data: null });
    setInjuries({ loading: true, data: null });

    api
      .oddsTable(sport, eventId)
      .then((data) => !cancelled && setOdds({ loading: false, error: null, data }))
      .catch((err) => !cancelled && setOdds({ loading: false, error: err.message, data: null }));

    api
      .injuries(sport, eventId)
      .then((data) => !cancelled && setInjuries({ loading: false, data }))
      .catch(() => !cancelled && setInjuries({ loading: false, data: null }));

    return () => {
      cancelled = true;
    };
  }, [sport, eventId]);

  const table = odds.data?.table;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{table ? `${table.awayTeam} @ ${table.homeTeam}` : "Game detail"}</h2>
          <button onClick={onClose}>✕</button>
        </div>

        {odds.loading && <p className="muted">Loading odds…</p>}
        {odds.error && <p className="error">{odds.error}</p>}
        {odds.data && !odds.data.oddsAvailable && (
          <p className="muted">No ODDS_API_KEY configured — odds table unavailable.</p>
        )}
        {odds.data?.oddsAvailable && !table && (
          <p className="muted">No live odds matched for this game right now.</p>
        )}

        {table && (
          <div className="odds-table-wrap">
            <table className="odds-table">
              <thead>
                <tr>
                  <th>Book</th>
                  <th>ML {table.awayTeam.split(" ").at(-1)}</th>
                  <th>ML {table.homeTeam.split(" ").at(-1)}</th>
                  <th>Spread {table.awayTeam.split(" ").at(-1)}</th>
                  <th>Spread {table.homeTeam.split(" ").at(-1)}</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {table.books.map((b) => {
                  const h2h = b.markets.h2h ?? [];
                  const spreads = b.markets.spreads ?? [];
                  const totals = b.markets.totals ?? [];
                  const away = (arr) => arr.find((o) => o.name === table.awayTeam);
                  const home = (arr) => arr.find((o) => o.name === table.homeTeam);
                  const over = totals.find((o) => o.name === "Over");
                  return (
                    <tr key={b.book}>
                      <td>{b.book}</td>
                      <td>{fmtOdds(away(h2h)?.price)}</td>
                      <td>{fmtOdds(home(h2h)?.price)}</td>
                      <td>
                        {away(spreads)?.point != null ? `${away(spreads).point > 0 ? "+" : ""}${away(spreads).point} ` : ""}
                        {fmtOdds(away(spreads)?.price)}
                      </td>
                      <td>
                        {home(spreads)?.point != null ? `${home(spreads).point > 0 ? "+" : ""}${home(spreads).point} ` : ""}
                        {fmtOdds(home(spreads)?.price)}
                      </td>
                      <td>
                        {over?.point != null ? `O/U ${over.point} ` : ""}
                        {fmtOdds(over?.price)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="injuries">
          <h3>Injuries</h3>
          {injuries.loading && <p className="muted">Loading…</p>}
          {!injuries.loading && (
            <div className="injuries-grid">
              {["away", "home"].map((side) => (
                <div key={side}>
                  <strong>{side === "home" ? table?.homeTeam ?? "Home" : table?.awayTeam ?? "Away"}</strong>
                  {injuries.data?.[side] == null ? (
                    <p className="muted small">Unavailable</p>
                  ) : injuries.data[side].length === 0 ? (
                    <p className="muted small">No listed injuries</p>
                  ) : (
                    <ul>
                      {injuries.data[side].map((inj, i) => (
                        <li key={i}>
                          {inj.player} — {inj.status}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
