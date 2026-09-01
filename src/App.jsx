import { useState } from "react";
import SportSwitcher from "./components/SportSwitcher.jsx";
import EdgeFeed from "./components/EdgeFeed.jsx";
import TrendFeed from "./components/TrendFeed.jsx";
import Games from "./components/Games.jsx";
import GameDetail from "./components/GameDetail.jsx";
import ParlaySlip from "./components/ParlaySlip.jsx";
import BetLog from "./components/BetLog.jsx";
import Calibration from "./components/Calibration.jsx";
import Disclaimer from "./components/Disclaimer.jsx";

const TABS = [
  { key: "edges", label: "Edge feed" },
  { key: "trends", label: "Trends" },
  { key: "games", label: "Games" },
  { key: "betlog", label: "Bet log" },
  { key: "calibration", label: "Calibration" },
];

export default function App() {
  const [sport, setSport] = useState("nfl");
  const [tab, setTab] = useState("edges");
  const [openGame, setOpenGame] = useState(null);
  const [slip, setSlip] = useState([]);
  const [betLogKey, setBetLogKey] = useState(0);

  function addLeg(leg) {
    setSlip((s) => [...s, leg]);
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
          {tab === "games" && <Games sport={sport} onSelectGame={setOpenGame} />}
          {tab === "betlog" && <BetLog refreshKey={betLogKey} />}
          {tab === "calibration" && <Calibration refreshKey={betLogKey} />}
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
