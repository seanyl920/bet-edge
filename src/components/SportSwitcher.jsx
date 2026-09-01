const SPORTS = [
  { key: "nfl", label: "NFL" },
  { key: "nba", label: "NBA" },
  { key: "mlb", label: "MLB" },
];

export default function SportSwitcher({ sport, onChange }) {
  return (
    <div className="sport-switcher">
      {SPORTS.map((s) => (
        <button
          key={s.key}
          className={s.key === sport ? "active" : ""}
          onClick={() => onChange(s.key)}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
