// Fixtures below are trimmed to the fields getConfirmedLineup actually
// reads, but the field names/shapes match a real live response confirmed
// against ESPN in Sept 2026 (Mets @ Rays for the "posted" case, Cardinals @
// Dodgers — same moment, much further from first pitch — for the "not
// posted yet" case). getConfirmedLineup calls the global fetch directly
// (no injectable client, matching the rest of mlbData.js's style), so this
// stubs globalThis.fetch rather than mocking a module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getConfirmedLineup } from "../server/mlbData.js";

const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(json) {
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: "OK", json: async () => json });
}

const CONFIRMED_SUMMARY = {
  header: {
    competitions: [
      {
        competitors: [
          { homeAway: "home", team: { id: "30" } }, // Rays
          { homeAway: "away", team: { id: "21" } }, // Mets
        ],
      },
    ],
  },
  boxscore: {
    players: [
      {
        team: { id: "21" }, // away = Mets
        statistics: [
          {
            athletes: [
              { starter: true, batOrder: 1, athlete: { id: "32129", displayName: "Francisco Lindor", position: { abbreviation: "SS" } } },
              { starter: true, batOrder: 2, athlete: { id: "99001", displayName: "Player Two", position: { abbreviation: "2B" } } },
            ],
          },
          { athletes: [{ starter: true, batOrder: 0, athlete: { id: "4991251", displayName: "Justin Hagenman", position: { abbreviation: "RP" } } }] },
        ],
      },
      {
        team: { id: "30" }, // home = Rays
        statistics: [
          {
            athletes: [
              { starter: true, batOrder: 1, athlete: { id: "33481", displayName: "Yandy Diaz", position: { abbreviation: "DH" } } },
              // A non-starter present in the same category shouldn't count.
              { starter: false, batOrder: null, athlete: { id: "88888", displayName: "Bench Guy" } },
            ],
          },
          { athletes: [{ starter: true, batOrder: 0, athlete: { id: "42604", displayName: "Griffin Jax", position: { abbreviation: "SP" } } }] },
        ],
      },
    ],
  },
};

const UNCONFIRMED_SUMMARY = {
  header: {
    competitions: [
      {
        competitors: [
          { homeAway: "home", team: { id: "19" } }, // Dodgers
          { homeAway: "away", team: { id: "24" } }, // Cardinals
        ],
      },
    ],
  },
  boxscore: {
    players: [
      { team: { id: "24" }, statistics: [{ athletes: [] }, { athletes: [] }] },
      { team: { id: "19" }, statistics: [{ athletes: [] }, { athletes: [] }] },
    ],
  },
};

test("getConfirmedLineup returns confirmed:true with real batting order once a lineup has posted", async () => {
  stubFetch(CONFIRMED_SUMMARY);
  const result = await getConfirmedLineup("evt-confirmed-1");

  assert.equal(result.home.confirmed, true);
  assert.equal(result.away.confirmed, true);

  assert.deepEqual(
    result.away.batters.map((b) => ({ id: b.id, battingOrder: b.battingOrder })),
    [
      { id: "32129", battingOrder: 1 },
      { id: "99001", battingOrder: 2 },
    ]
  );
  assert.equal(result.home.batters.length, 1);
  assert.equal(result.home.batters[0].name, "Yandy Diaz");
  assert.equal(result.home.batters[0].battingOrder, 1);

  // The confirmed starter's own boxscore position is a real opener/bulk-
  // reliever signal — Hagenman shows "RP" despite being the Mets' listed
  // starter (this is the actual live-confirmed contrast the diagnostic
  // caught: a traditional starter is "SP", an opener/bulk-reliever isn't).
  assert.deepEqual(result.home.startingPitcherRole, { id: "42604", role: "SP" });
  assert.deepEqual(result.away.startingPitcherRole, { id: "4991251", role: "RP" });
});

test("getConfirmedLineup excludes a non-starter present in the same boxscore category", async () => {
  stubFetch(CONFIRMED_SUMMARY);
  const result = await getConfirmedLineup("evt-confirmed-2");
  assert.ok(!result.home.batters.some((b) => b.id === "88888"), "bench player with starter:false must not appear as a confirmed starter");
});

test("getConfirmedLineup returns confirmed:false and an EMPTY batters array — never the pitcher's own entry, never a guess — when no lineup has posted yet", async () => {
  stubFetch(UNCONFIRMED_SUMMARY);
  const result = await getConfirmedLineup("evt-unconfirmed-1");

  assert.equal(result.home.confirmed, false);
  assert.deepEqual(result.home.batters, []);
  assert.equal(result.home.startingPitcherRole, null);
  assert.equal(result.away.confirmed, false);
  assert.deepEqual(result.away.batters, []);
  assert.equal(result.away.startingPitcherRole, null);
});

test("getConfirmedLineup never throws when the request fails", async () => {
  globalThis.fetch = async () => {
    throw new Error("simulated network failure");
  };
  // No try/catch here on purpose — an unexpected throw fails this test
  // automatically, which is exactly the "never throws" guarantee being
  // checked.
  const result = await getConfirmedLineup("evt-fail-1");
  assert.equal(result.home.confirmed, false);
  assert.equal(result.away.confirmed, false);
});

test("getConfirmedLineup never throws on a malformed response (missing boxscore/header entirely)", async () => {
  stubFetch({});
  const result = await getConfirmedLineup("evt-malformed-1");
  assert.equal(result.home.confirmed, false);
  assert.equal(result.away.confirmed, false);
});
