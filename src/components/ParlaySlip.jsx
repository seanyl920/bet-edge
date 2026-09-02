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
    // Confirmed real bug: with no request-ordering guard, adding a leg
    // quickly (e.g. 2 legs -> 3 legs) fires two overlapping combine
    // requests, and if the older (2-leg) response happened to arrive after
    // the newer (3-leg) one, setCombined would silently overwrite the
    // current, correct price with the stale one — and "Log this bet" had
    // no way to know that had happened. Reproduced exactly that: a 3-leg
    // slip logged at the 2-leg price. Fixed with the standard
    // stale-response guard (clear `combined` immediately so nothing stale
    // can be logged while the new price is in flight, and ignore a
    // response that arrives after this effect has already been superseded).
    let cancelled = false;
    setCombined(null);
    setError(null);
    api
      .combineParlay(legs)
      .then((result) => {
        if (!cancelled) setCombined(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
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
        // Always store the full leg array (including single-leg bets) — this is
        // the snapshot the postmortem engine grades against later.
        legs,
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
                {combined.correlationAdjusted.payoutIsHypothetical && (
                  <div className="muted small">
                    priced against the naive product of individual legs — not a real quoted same-game price, see below
                  </div>
                )}
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

      {(() => {
        // Confirmed real bug: this button was only ever disabled while
        // actively submitting — not while the combined price was still
        // being recalculated for the current legs (or had failed to). A
        // 2+ leg slip with no `combined` yet (still loading, or the fetch
        // errored) could still be logged, using `combined`'s stale/absent
        // fields. Block logging until the price actually matches what's on
        // screen.
        const priceStale = legs.length >= 2 && !combined && !error;
        return (
          <button className="primary" disabled={logging || priceStale} onClick={logBet}>
            {logging ? "Logging…" : priceStale ? "Calculating…" : "Log this bet"}
          </button>
        );
      })()}
    </div>
  );
}
