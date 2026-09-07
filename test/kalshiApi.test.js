// Test coverage for kalshiApi.js. Covers what's verifiable without live
// network access (this sandbox can't reach kalshi.com — see the file's own
// header comment for what the user already confirmed live: base URL,
// /markets response shape, the decimal-dollar price string format, and
// real rate limiting on this public endpoint). NBA/MLB series naming and
// the moneyline-equivalent (near-zero strike) contract remain UNVERIFIED.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getMarkets, getEvents, getMarketOrderbook, dollarStringToProb } from "../server/kalshiApi.js";
import { clearCache } from "../server/cache.js";

const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
});

test("dollarStringToProb parses Kalshi's real decimal-dollar price format directly as a probability", () => {
  // Confirmed live: e.g. "yes_ask_dollars": "0.3100" for a market priced at 31 cents.
  assert.equal(dollarStringToProb("0.3100"), 0.31);
  assert.equal(dollarStringToProb("0.0100"), 0.01);
  assert.equal(dollarStringToProb("0.9900"), 0.99);
});

test("dollarStringToProb returns null (never fabricates) for a missing or non-numeric value", () => {
  assert.equal(dollarStringToProb(null), null);
  assert.equal(dollarStringToProb(undefined), null);
  assert.equal(dollarStringToProb("not-a-number"), null);
});

test("getMarkets requests the expected query params and returns the markets array", async () => {
  clearCache();
  let requestedUrl = null;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return { ok: true, status: 200, json: async () => ({ markets: [{ ticker: "M1" }] }) };
  };
  const result = await getMarkets({ seriesTicker: "KXNFLSPREAD", status: "open" });
  assert.deepEqual(result, [{ ticker: "M1" }]);
  assert.ok(requestedUrl.includes("series_ticker=KXNFLSPREAD"));
  assert.ok(requestedUrl.includes("status=open"));
});

test("getMarkets returns an empty array (never throws) when the response has no markets field", async () => {
  clearCache();
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const result = await getMarkets();
  assert.deepEqual(result, []);
});

test("getEvents requests the events endpoint and returns the events array", async () => {
  clearCache();
  let requestedUrl = null;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return { ok: true, status: 200, json: async () => ({ events: [{ event_ticker: "KXNFLSPREAD-26SEP14DENKC" }] }) };
  };
  const result = await getEvents({ seriesTicker: "KXNFLSPREAD" });
  assert.deepEqual(result, [{ event_ticker: "KXNFLSPREAD-26SEP14DENKC" }]);
  assert.ok(requestedUrl.includes("/events?"));
});

test("getMarketOrderbook fetches the specific market's orderbook by ticker", async () => {
  clearCache();
  let requestedUrl = null;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return { ok: true, status: 200, json: async () => ({ orderbook: { yes: [[65, 10]], no: [[34, 5]] } }) };
  };
  const result = await getMarketOrderbook("KXNFLSPREAD-26SEP14DENKC-KC8");
  assert.deepEqual(result, { yes: [[65, 10]], no: [[34, 5]] });
  assert.ok(requestedUrl.includes("/markets/KXNFLSPREAD-26SEP14DENKC-KC8/orderbook"));
});

test("a non-ok response is thrown as a real error carrying the HTTP status", async () => {
  clearCache();
  globalThis.fetch = async () => ({ ok: false, status: 404, statusText: "Not Found", text: async () => "market not found" });
  await assert.rejects(() => getMarketOrderbook("bad-ticker"), (err) => err.status === 404);
});

test("a real HTTP 429 is surfaced as a RATE_LIMITED-coded error, not a generic failure", async () => {
  clearCache();
  globalThis.fetch = async () => ({ ok: false, status: 429, statusText: "Too Many Requests", text: async () => "" });
  await assert.rejects(() => getMarkets({ seriesTicker: `KXRATE429-${Math.random()}` }), (err) => err.code === "RATE_LIMITED");
});

test("a 200 response carrying Kalshi's own too_many_requests error body is ALSO surfaced as RATE_LIMITED (confirmed live — both shapes happen)", async () => {
  clearCache();
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ error: { code: "too_many_requests", message: "too many requests" } }) });
  await assert.rejects(() => getMarkets({ seriesTicker: `KXRATEBODY-${Math.random()}` }), (err) => err.code === "RATE_LIMITED");
});

test("getMarkets caches repeated calls with the same params — doesn't refetch within the TTL", async () => {
  clearCache();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ markets: [{ ticker: `call-${calls}` }] }) };
  };
  const first = await getMarkets({ seriesTicker: "KXCACHETEST-fixed" });
  const second = await getMarkets({ seriesTicker: "KXCACHETEST-fixed" });
  assert.equal(calls, 1, "the second call must be served from cache, not re-fetched");
  assert.deepEqual(first, second);
});
