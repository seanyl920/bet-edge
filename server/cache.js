// Tiny in-memory TTL cache. The Odds API free tier is 500 requests/month,
// so anything that hits it needs to be cached aggressively rather than
// re-fetched on every page load.

const store = new Map();

export async function cached(key, ttlMs, fn) {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && hit.expires > now) return hit.promise;

  // Confirmed real gap: this used to `await fn()` before storing anything,
  // so N concurrent calls for the same still-uncached key each ran their
  // own upstream fetch — wasteful always, and a real problem against The
  // Odds API's tight free-tier quota. Store the in-flight PROMISE itself
  // (not just the eventual value) so concurrent callers share one fetch;
  // `await`ing a promise-returning function is transparent to callers
  // either way, so this doesn't change what `cached()` returns.
  const promise = Promise.resolve().then(fn);
  store.set(key, { promise, expires: now + ttlMs });
  // A failure was never cached before (the old code only stored after a
  // successful await) — preserve that: remove this entry on rejection so
  // the next call gets a fresh attempt instead of the same error replayed
  // for the rest of ttlMs. Only remove it if it's still THIS attempt (a
  // newer one may have already replaced it, e.g. via clearCache()).
  promise.catch(() => {
    if (store.get(key)?.promise === promise) store.delete(key);
  });
  return promise;
}

export function cacheStats() {
  return { keys: [...store.keys()], size: store.size };
}

export function clearCache(prefix) {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}
