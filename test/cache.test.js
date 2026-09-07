// First-ever test coverage for cache.js — the in-memory TTL cache guarding
// The Odds API's tight free-tier quota (500 req/month). Its own comments
// document a real, already-fixed bug (concurrent calls for the same
// uncached key each ran their own upstream fetch) — these tests exist to
// make sure that stays fixed, along with the TTL and failure-eviction
// behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.ODDS_CACHE_FILE = path.join(await mkdtemp(path.join(tmpdir(), "cache-test-")), "oddsCache.json");
const dir = path.dirname(process.env.ODDS_CACHE_FILE);

const { cached, cacheStats, clearCache } = await import("../server/cache.js");

function uniqueKey(label) {
  return `test:${label}:${Math.random().toString(36).slice(2)}`;
}

test("cached returns the freshly-computed value on a cache miss", async () => {
  const key = uniqueKey("miss");
  const result = await cached(key, 10_000, async () => "fresh-value");
  assert.equal(result, "fresh-value");
});

test("cached returns the SAME value on a hit within the TTL, without calling fn again", async () => {
  const key = uniqueKey("hit");
  let calls = 0;
  const fn = async () => {
    calls += 1;
    return `call-${calls}`;
  };
  const first = await cached(key, 10_000, fn);
  const second = await cached(key, 10_000, fn);
  assert.equal(first, "call-1");
  assert.equal(second, "call-1", "a hit within the TTL must never re-invoke fn");
  assert.equal(calls, 1);
});

test("cached re-fetches once the TTL has expired", async () => {
  const key = uniqueKey("expiry");
  let calls = 0;
  const fn = async () => {
    calls += 1;
    return calls;
  };
  const first = await cached(key, 20, fn); // 20ms TTL
  await new Promise((r) => setTimeout(r, 40));
  const second = await cached(key, 20, fn);
  assert.equal(first, 1);
  assert.equal(second, 2, "expired entries must be re-fetched, not served stale forever");
});

test("cached shares ONE in-flight fetch across concurrent callers for the same uncached key (the confirmed real bug this module's comments describe)", async () => {
  const key = uniqueKey("concurrent");
  let calls = 0;
  const fn = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 30));
    return "shared-value";
  };
  // Fire several concurrent calls before the first one has resolved.
  const [a, b, c] = await Promise.all([cached(key, 10_000, fn), cached(key, 10_000, fn), cached(key, 10_000, fn)]);
  assert.equal(calls, 1, "N concurrent calls for the same still-uncached key must share ONE upstream fetch");
  assert.equal(a, "shared-value");
  assert.equal(b, "shared-value");
  assert.equal(c, "shared-value");
});

test("cached does not cache a rejection — the next call gets a fresh attempt instead of the same error replayed", async () => {
  const key = uniqueKey("failure");
  let calls = 0;
  const fn = async () => {
    calls += 1;
    if (calls === 1) throw new Error("simulated upstream failure");
    return "recovered";
  };
  await assert.rejects(() => cached(key, 10_000, fn));
  const second = await cached(key, 10_000, fn);
  assert.equal(second, "recovered", "a failed attempt must not be cached for the rest of the TTL");
});

test("clearCache(prefix) removes only keys starting with that prefix", async () => {
  const keyA = `prefixA:${Math.random()}`;
  const keyB = `prefixB:${Math.random()}`;
  await cached(keyA, 10_000, async () => "a");
  await cached(keyB, 10_000, async () => "b");
  clearCache("prefixA:");
  const stats = cacheStats();
  assert.ok(!stats.keys.includes(keyA));
  assert.ok(stats.keys.includes(keyB));
});

test("clearCache() with no prefix clears everything", async () => {
  await cached(uniqueKey("clearall"), 10_000, async () => "x");
  clearCache();
  assert.equal(cacheStats().size, 0);
});

test("cached({persist: true}) survives the in-memory store being forgotten — the actual scenario a server restart reproduces", async () => {
  const key = uniqueKey("persist-restart");
  let calls = 0;
  const fn = async () => {
    calls += 1;
    return `persisted-value-${calls}`;
  };
  const first = await cached(key, 10_000, fn, { persist: true });
  assert.equal(first, "persisted-value-1");

  // Simulate a restart: clearCache() wipes the in-memory Map exactly like
  // a fresh `node server/index.js` process would start with an empty one
  // — but the disk file cached() wrote to is still there.
  clearCache();

  const second = await cached(key, 10_000, fn, { persist: true });
  assert.equal(second, "persisted-value-1", "must be restored from disk, not re-fetched, after the in-memory store is gone");
  assert.equal(calls, 1, "fn must not be called again — this is the actual quota-saving behavior");
});

test("cached({persist: true}) still re-fetches once the persisted entry's TTL has actually expired", async () => {
  const key = uniqueKey("persist-expiry");
  let calls = 0;
  const fn = async () => {
    calls += 1;
    return calls;
  };
  await cached(key, 20, fn, { persist: true });
  clearCache();
  await new Promise((r) => setTimeout(r, 40));
  const second = await cached(key, 20, fn, { persist: true });
  assert.equal(second, 2, "an expired disk entry must not be served as if it were still fresh");
});

test("cached() without persist never touches disk — a plain call's value is lost across a simulated restart", async () => {
  const key = uniqueKey("no-persist");
  let calls = 0;
  const fn = async () => {
    calls += 1;
    return calls;
  };
  await cached(key, 10_000, fn); // no persist option
  clearCache();
  await cached(key, 10_000, fn);
  assert.equal(calls, 2, "without persist:true, forgetting the in-memory store must force a real re-fetch (this is the existing, unchanged default behavior)");
});

test.after(async () => {
  await rm(dir, { recursive: true, force: true });
});
