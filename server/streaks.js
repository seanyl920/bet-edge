// Pure streak/rate math over a normalized, most-recent-game-first log.
// No I/O, no ESPN-shape knowledge — easy to trust and easy to reuse for any
// stat you point it at.

/** How many of the most recent games (starting from index 0) satisfy `predicate`, consecutively. */
export function consecutiveStreak(games, predicate) {
  let streak = 0;
  for (const g of games) {
    if (predicate(g)) streak += 1;
    else break;
  }
  return streak;
}

/** How many of the last `n` games satisfy `predicate` (not required to be consecutive). */
export function countInLastN(games, n, predicate) {
  return games.slice(0, n).filter(predicate).length;
}

/**
 * Aggregate performance against one specific opponent team, from whatever
 * games are in the log. Currently that's this-season-only (see mlbData.js —
 * multi-season data was never verified against a live response), so this
 * can legitimately come back thin or empty for a team the batter has only
 * faced a handful of times this year, even if they've owned that team for
 * years. Treat `games`/`AB` as the trust signal, not just `avg`.
 */
export function vsTeamSplit(games, opponentTeamId) {
  const relevant = games.filter((g) => g.opponentTeamId === opponentTeamId && g.AB != null);
  const AB = relevant.reduce((s, g) => s + (g.AB || 0), 0);
  const H = relevant.reduce((s, g) => s + (g.H || 0), 0);
  const HR = relevant.reduce((s, g) => s + (g.HR || 0), 0);
  return { games: relevant.length, AB, H, HR, avg: AB > 0 ? H / AB : null };
}
