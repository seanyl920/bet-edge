import { useState } from "react";
import SportSwitcher from "./components/SportSwitcher.jsx";
import EdgeFeed from "./components/EdgeFeed.jsx";
import TrendFeed from "./components/TrendFeed.jsx";
import DailyParlay from "./components/DailyParlay.jsx";
import Games from "./components/Games.jsx";
import GameDetail from "./components/GameDetail.jsx";
import ParlaySlip from "./components/ParlaySlip.jsx";
import BetLog from "./components/BetLog.jsx";
import Calibration from "./components/Calibration.jsx";
import PredictionEval from "./components/PredictionEval.jsx";
import Disclaimer from "./components/Disclaimer.jsx";

const TABS = [
  { key: "edges", label: "Edge feed" },
  { key: "trends", label: "Trends" },
  { key: "dailyParlay", label: "Daily parlay" },
  { key: "games", label: "Games" },
  { key: "betlog", label: "Bet log" },
  { key: "calibration", label: "Calibration" },
  { key: "modelEval", label: "Model eval" },
];

export default function App() {
  const [sport, setSport] = useState("nfl");
  const [tab, setTab] = useState("edges");
  const [openGame, setOpenGame] = useState(null);
  const [slip, setSlip] = useState([]);
  const [betLogKey, setBetLogKey] = useState(0);

  // Confirmed real bug (external review, Sept 2026): clicking "+ Slip"
  // repeatedly (or on the same outcome from two different feeds) just kept
  // appending — the server then priced every copy as an independent leg,
  // producing a wildly inflated combined payout for what's really one bet
  // placed twice (see parlay.js's matching identity check, kept here too
  // as the first line of defense so a duplicate never even reaches the
  // server). Same identity as there: (eventId, market, selection) — the
  // same real-world outcome, regardless of price/book.
  function legIdentityKey(l) {
    return `${l.eventId ?? ""}|${l.market ?? ""}|${l.selection ?? ""}`;
  }
  function addLeg(leg) {
    setSlip((s) => {
      const key = legIdentityKey(leg);
      if (s.some((l) => legIdentityKey(l) === key)) {
        console.warn(`[BetEdge] "${leg.label ?? leg.selection}" is already in the slip — not adding it twice.`);
        return s;
      }
      return [...s, leg];
    });
  }
  function removeLeg(i) {
    setSlip((s) => s.filter((_, idx) => idx !== i));
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>🎯 BetEdge</h1>
        <SportSwitcher sport={sport} onChange={setSport} />
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.key} className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <Disclaimer />

      <main className="app-main">
        <div className="app-content">
          {tab === "edges" && <EdgeFeed sport={sport} onAddLeg={addLeg} onSelectGame={setOpenGame} />}
          {tab === "trends" && <TrendFeed sport={sport} onAddLeg={addLeg} />}
          {tab === "dailyParlay" && <DailyParlay onAddLeg={addLeg} />}
          {tab === "games" && <Games sport={sport} onSelectGame={setOpenGame} />}
          {tab === "betlog" && <BetLog refreshKey={betLogKey} />}
          {tab === "calibration" && <Calibration refreshKey={betLogKey} />}
          {tab === "modelEval" && <PredictionEval />}
        </div>
        <aside className="app-slip">
          <ParlaySlip
            legs={slip}
            onRemove={removeLeg}
            onClear={() => setSlip([])}
            onLogged={() => setBetLogKey((k) => k + 1)}
          />
        </aside>
      </main>

      {openGame && (
        <GameDetail sport={sport} eventId={openGame} onClose={() => setOpenGame(null)} onAddLeg={addLeg} />
      )}
    </div>
  );
}
