import { useEffect, useState } from "react";
import { api } from "../api.js";

export default function Calibration({ refreshKey }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    setState({ loading: true, error: null, data: null });
    api
      .calibration()
      .then((data) => setState({ loading: false, error: null, data }))
      .catch((err) => setState({ loading: false, error: err.message, data: null }));
  }, [refreshKey]);

  const { loading, error, data } = state;

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Calibration</h2>
      </div>
      <p className="muted small">
        Real hit rates from your own graded bets, bucketed by trend type/score or by the edge feed's model
        probability. A bucket needs at least <strong>{data?.minSample ?? 15}</strong> graded legs before it's
        trusted enough to actually change how trends are ranked — those rows are marked "calibrated" below;
        everything else is shown for visibility only.
      </p>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}

      {data && data.buckets.length === 0 && (
        <p className="muted">
          No graded legs yet. Log bets from the Edge feed or Trends tab, mark results in the Bet log, and
          this fills in automatically.
        </p>
      )}

      {data && data.buckets.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Bucket</th>
              <th>Graded legs</th>
              <th>Hit rate</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.buckets.map((b) => (
              <tr key={b.key}>
                <td>{b.label}</td>
                <td>{b.n}</td>
                <td className={b.hitRatePct >= 50 ? "pos" : "neg"}>{b.hitRatePct}%</td>
                <td>
                  {b.calibrated ? (
                    <span className="badge badge-ok">calibrated — influencing ranking</span>
                  ) : (
                    <span className="badge badge-low">needs {data.minSample - b.n} more</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
