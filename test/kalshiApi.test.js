// First-ever test coverage for kalshiApi.js. Covers what can be verified
// without live network access (this sandbox can't reach kalshi.com — see
// the file's own header comment): request construction, caching, and the
// cents-to-probability conversion. The real series_ticker naming and
// sports coverage remain UNVERIFIED until checked against a live response.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getMarkets, getEvents, getMarketOrderbook, centsToImpliedProb } from "../server/kalshiApi.js";
import { clearCache } from "../server/cache.js";

const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
});

test("centsToImpliedProb converts Kalshi's cents price directly to a probability, no devig needed", () => {
  assert.equal(centsToImpliedProb(65), 0.65);
  assert.equal(centsToImpliedProb(1), 0.01);
  assert.equal(centsToImpliedProb(99), 0.99);
});

test("centsToImpliedProb returns null (never fabricates) for a missing or non-finite price", () => {
  assert.equal(centsToImpliedProb(null), null);
  assert.equal(centsToImpliedProb(undefined), null);
  assert.equal(centsToImpliedProb(NaN), null);
});

test("getMarkets requests the expected query params and returns the markets array", async () => {
  clearCache();
  let requestedUrl = null;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ markets: [{ ticker: "M1" }] }) };
  };
  const result = await getMarkets({ seriesTicker: "KXNFLGAME", status: "open" });
  assert.deepEqual(result, [{ ticker: "M1" }]);
  assert.ok(requestedUrl.includes("series_ticker=KXNFLGAME"));
  assert.ok(requestedUrl.includes("status=open"));
});

test("getMarkets returns an empty array (never throws) when the response has no markets field", async () => {
  clearCache();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  const result = await getMarkets();
  assert.deepEqual(result, []);
});

test("getEvents requests the events endpoint and returns the events array", async () => {
  clearCache();
  let requestedUrl = null;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ events: [{ event_ticker: "E1" }] }) };
  };
  const result = await getEvents({ seriesTicker: "KXNFLGAME" });
  assert.deepEqual(result, [{ event_ticker: "E1" }]);
  assert.ok(requestedUrl.includes("/events?"));
});

test("getMarketOrderbook fetches the specific market's orderbook by ticker", async () => {
  clearCache();
  let requestedUrl = null;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ orderbook: { yes: [[65, 10]], no: [[34, 5]] } }) };
  };
  const result = await getMarketOrderbook("NFL-25SEP10-KC");
  assert.deepEqual(result, { yes: [[65, 10]], no: [[34, 5]] });
  assert.ok(requestedUrl.includes("/markets/NFL-25SEP10-KC/orderbook"));
});

test("a non-ok response is thrown as a real error carrying the HTTP status", async () => {
  clearCache();
  globalThis.fetch = async () => ({ ok: false, status: 404, statusText: "Not Found", text: async () => "market not found" });
  await assert.rejects(() => getMarketOrderbook("bad-ticker"), (err) => err.status === 404);
});

test("getMarkets caches repeated calls with the same params — doesn't refetch within the TTL", async () => {
  clearCache();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ markets: [{ ticker: `call-${calls}` }] }) };
  };
  const first = await getMarkets({ seriesTicker: "KXCACHETEST" });
  const second = await getMarkets({ seriesTicker: "KXCACHETEST" });
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
});
