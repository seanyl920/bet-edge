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
