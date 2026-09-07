// Tiny in-memory TTL cache. The Odds API free tier is 500 requests/month,
// so anything that hits it needs to be cached aggressively rather than
// re-fetched on every page load.
//
// Confirmed real gap (user hit their monthly Odds API quota): this cache
// was ONLY ever in-memory — every `node server/index.js` restart (a plain
// `node` process, no watch/reload — see package.json's dev:server) forgot
// everything, so the very next page load re-fetched bulk odds fresh for
// every sport at once, and any player-prop check made moments before a
// restart got thrown away and re-fetched again after. Across a normal dev
// cycle (stop/restart the server after every `git pull`, click through a
// few tabs to check things look right) that adds up fast against a 500/mo
// budget. `cached(key, ttlMs, fn, { persist: true })` now also persists to
// a small JSON file on disk, so a restart can pick up a still-fresh entry
// instead of paying for it again. Opt-in (default false) — this app's
// other cached calls (ESPN scoreboard/teams, weather) have no quota
// pressure and don't need the extra disk I/O.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
// Overridable so tests can point this at a throwaway file — same pattern
// predictionLog.js/betlog.js already use.
const DISK_FILE = process.env.ODDS_CACHE_FILE ? path.resolve(process.env.ODDS_CACHE_FILE) : path.join(DATA_DIR, "oddsCache.json");

const store = new Map();

// Lazily loaded once per process, the same pattern predictionLog.js's
// ensureLoggedTodayLoaded() uses — concurrent first-callers share one load
// via `diskLoadPromise` rather than each re-reading the file.
let diskStore = null; // key -> { value, expires } once loaded
let diskLoadPromise = null;

async function ensureDiskLoaded() {
  if (diskStore) return;
  if (!diskLoadPromise) {
    diskLoadPromise = (async () => {
      try {
        diskStore = JSON.parse(await readFile(DISK_FILE, "utf-8"));
      } catch {
        // Missing file, corrupt JSON, whatever — start empty rather than
        // block every cached() call behind a disk-cache read failure.
        diskStore = {};
      }
    })();
  }
  await diskLoadPromise;
}

// Best-effort — a failed disk write must never break the caller waiting
// on the actual data.
async function saveDiskCache() {
  try {
    await mkdir(path.dirname(DISK_FILE), { recursive: true });
    await writeFile(DISK_FILE, JSON.stringify(diskStore));
  } catch (err) {
    console.warn(`[cache] failed to persist disk cache (non-fatal): ${err.message}`);
  }
}

export async function cached(key, ttlMs, fn, { persist = false } = {}) {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && hit.expires > now) return hit.promise;

  if (persist) {
    await ensureDiskLoaded();
    const diskHit = diskStore[key];
    if (diskHit && diskHit.expires > now) {
      // Seed the in-memory store from the disk value so the rest of this
      // process's calls for this key also hit fast, without re-parsing
      // the file or re-fetching.
      const promise = Promise.resolve(diskHit.value);
      store.set(key, { promise, expires: diskHit.expires });
      return promise;
    }
  }

  // Confirmed real gap: this used to `await fn()` before storing anything,
  // so N concurrent calls for the same still-uncached key each ran their
  // own upstream fetch — wasteful always, and a real problem against The
  // Odds API's tight free-tier quota. Store the in-flight PROMISE itself
  // (not just the eventual value) so concurrent callers share one fetch;
  // `await`ing a promise-returning function is transparent to callers
  // either way, so this doesn't change what `cached()` returns.
  const expires = now + ttlMs;
  const promise = Promise.resolve().then(fn);
  store.set(key, { promise, expires });
  // A failure was never cached before (the old code only stored after a
  // successful await) — preserve that: remove this entry on rejection so
  // the next call gets a fresh attempt instead of the same error replayed
  // for the rest of ttlMs. Only remove it if it's still THIS attempt (a
  // newer one may have already replaced it, e.g. via clearCache()).
  promise.catch(() => {
    if (store.get(key)?.promise === promise) store.delete(key);
  });
  if (persist) {
    promise.then(
      async (value) => {
        await ensureDiskLoaded();
        diskStore[key] = { value, expires };
        await saveDiskCache();
      },
      () => {} // a rejected fetch is never persisted, same as the in-memory behavior above
    );
  }
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
