import { useEffect, useState } from "react";
import { api } from "../api.js";

function pct(x) {
  return x == null ? "—" : `${(x * 100).toFixed(0)}%`;
}

export default function Games({ sport, onSelectGame }) {
  const [state, setState] = useState({ loading: true, error: null, games: [] });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: null, games: [] });
    api
      .games(sport)
      .then((data) => !cancelled && setState({ loading: false, error: null, games: data.games }))
      .catch((err) => !cancelled && setState({ loading: false, error: err.message, games: [] }));
    return () => {
      cancelled = true;
    };
  }, [sport]);

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Upcoming games</h2>
      </div>
      {state.loading && <p className="muted">Loading…</p>}
      {state.error && <p className="error">{state.error}</p>}
      <div className="game-grid">
        {state.games.map((g) => (
          <button className="game-card" key={g.id} onClick={() => onSelectGame(g.id)}>
            <div className="game-card-time">{new Date(g.date).toLocaleString()}</div>
            <div className="game-card-row">
              <span>{g.away.name}</span>
              <span className="muted small">Elo {g.away.elo}</span>
            </div>
            <div className="game-card-row">
              <span>{g.home.name}</span>
              <span className="muted small">Elo {g.home.elo}</span>
            </div>
            <div className="game-card-footer">
              <span>Model: home {pct(g.model.homeWinProb)}</span>
              <span className="muted small">{g.model.sampleSize} games sampled</span>
            </div>
            {g.weather && <div className="muted small">🌤 {g.weather.note}</div>}
            {g.mlbContext && (
              <div className="muted small mlb-context">
                {[g.mlbContext.away, g.mlbContext.home].map((side, i) =>
                  side.pitcher ? (
                    <div key={i}>
                      {side.pitcher.name}
                      {side.pitcher.confirmedRole && side.pitcher.confirmedRole !== "SP" ? ` (${side.pitcher.confirmedRole})` : ""}:
                      {" "}K-BB% {side.pitcher.kMinusBBPercent ?? "—"}
                      {!side.lineupConfirmed ? " · lineup not confirmed yet" : ""}
                    </div>
                  ) : null
                )}
              </div>
            )}
          </button>
        ))}
      </div>
      {!state.loading && state.games.length === 0 && !state.error && (
        <p className="muted">No upcoming games found.</p>
      )}
    </div>
  );
}
