// Tiny in-memory TTL cache. The Odds API free tier is 500 requests/month,
// so anything that hits it needs to be cached aggressively rather than
// re-fetched on every page load.

const store = new Map();

export async function cached(key, ttlMs, fn) {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && hit.expires > now) return hit.value;
  const value = await fn();
  store.set(key, { value, expires: now + ttlMs });
  return value;
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
