import { useEffect, useState } from "react";
import { api } from "../api.js";

function fmtOdds(american) {
  if (american == null) return "—";
  return american > 0 ? `+${american}` : `${american}`;
}
function pct(x) {
  return x == null ? "—" : `${(x * 100).toFixed(1)}%`;
}

export default function ParlaySlip({ legs, onRemove, onClear, onLogged }) {
  const [combined, setCombined] = useState(null);
  const [error, setError] = useState(null);
  const [stake, setStake] = useState(10);
  const [logging, setLogging] = useState(false);

  useEffect(() => {
    if (legs.length < 2) {
      setCombined(null);
      return;
    }
    api
      .combineParlay(legs)
      .then(setCombined)
      .catch((err) => setError(err.message));
  }, [legs]);

  async function logBet() {
    setLogging(true);
    try {
      const single = legs.length === 1 ? legs[0] : null;
      await api.addBet({
        sport: single?.sport ?? legs[0]?.sport,
        eventId: single?.eventId ?? null,
        matchup: single?.matchup ?? `${legs.length}-leg parlay`,
        market: single?.market ?? "parlay",
        selection: single?.selection ?? legs.map((l) => l.label).join(" + "),
        americanOdds: legs.length === 1 ? legs[0].americanOdds : combined?.combinedAmericanOdds,
        stake,
        modelProb: legs.length === 1 ? legs[0].trueProb : combined?.naive.trueProb,
        legs: legs.length > 1 ? legs : null,
      });
      onLogged();
      onClear();
    } finally {
      setLogging(false);
    }
  }

  if (legs.length === 0) {
    return (
      <div className="panel slip">
        <h2>Slip</h2>
        <p className="muted small">Add legs from the edge feed or a game's odds table.</p>
      </div>
    );
  }

  return (
    <div className="panel slip">
      <div className="panel-header">
        <h2>Slip ({legs.length})</h2>
        <button className="link" onClick={onClear}>
          Clear
        </button>
      </div>

      <ul className="slip-legs">
        {legs.map((l, i) => (
          <li key={i}>
            <div>
              <div>{l.label ?? l.selection}</div>
              <div className="muted small">
                {l.matchup} · {fmtOdds(l.americanOdds)}
              </div>
            </div>
            <button className="link" onClick={() => onRemove(i)}>
              ✕
            </button>
          </li>
        ))}
      </ul>

      {legs.length === 1 && (
        <div className="slip-summary">
          <div>Price: {fmtOdds(legs[0].americanOdds)}</div>
          <div>Model prob: {pct(legs[0].trueProb)}</div>
        </div>
      )}

      {error && <p className="error">{error}</p>}

      {combined && (
        <div className="slip-summary">
          <div className="slip-summary-row">
            <span>Naive parlay</span>
            <span>
              {fmtOdds(combined.naive.americanOdds)} · {pct(combined.naive.trueProb)} ·{" "}
              {combined.naive.ev >= 0 ? "+" : ""}
              {(combined.naive.ev * 100).toFixed(1)}% EV
            </span>
          </div>
          {combined.correlationAdjusted && (
            <div className="slip-summary-row warn">
              <span>Correlation-adjusted</span>
              <span>
                {pct(combined.correlationAdjusted.trueProb)} ·{" "}
                {(combined.correlationAdjusted.ev * 100).toFixed(1)}% EV
              </span>
            </div>
          )}
          {combined.correlationWarnings.map((w, i) => (
            <p className="warning-note" key={i}>
              ⚠ {w}
            </p>
          ))}
        </div>
      )}

      <label className="stake-input">
        Stake ($)
        <input type="number" min="0" value={stake} onChange={(e) => setStake(Number(e.target.value))} />
      </label>

      <button className="primary" disabled={logging} onClick={logBet}>
        {logging ? "Logging…" : "Log this bet"}
      </button>
    </div>
  );
}
