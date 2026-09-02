// getMlbGameContext composes getProbablePitchers/getConfirmedLineup
// (mlbData.js) and getPitcherProfileByName (savantData.js) — all of which
// already have their own focused tests. This exercises the composition
// itself: does the right piece end up on the right side, does a
// substitution correctly block role misattribution, does days-rest-style
// data stay absent (not zeroed/guessed) when nothing is found. Stubs
// globalThis.fetch by URL, same technique as the rest of this session's
// tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getMlbGameContext } from "../server/mlbGameContext.js";
import { clearCache } from "../server/cache.js";

const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
});

function summaryFixture({ homeId, awayId, homePitcherId, awayPitcherId, confirmed }) {
  const athleteEntry = (id, name, role) => ({
    starter: true,
    batOrder: 0,
    athlete: { id, displayName: name, position: { abbreviation: role } },
  });
  return {
    header: {
      competitions: [
        {
          competitors: [
            {
              homeAway: "home",
              team: { id: homeId },
              probables: [{ athlete: { id: homePitcherId, displayName: "Home Pitcher" }, statistics: { splits: { categories: [] } } }],
            },
            {
              homeAway: "away",
              team: { id: awayId },
              probables: [{ athlete: { id: awayPitcherId, displayName: "Away Pitcher" }, statistics: { splits: { categories: [] } } }],
            },
          ],
        },
      ],
    },
    boxscore: {
      players: confirmed
        ? [
            { team: { id: awayId }, statistics: [{ athletes: [{ starter: true, batOrder: 1, athlete: { id: "b1", displayName: "Batter One" } }] }, { athletes: [athleteEntry(awayPitcherId, "Away Pitcher", "SP")] }] },
            { team: { id: homeId }, statistics: [{ athletes: [{ starter: true, batOrder: 1, athlete: { id: "b2", displayName: "Batter Two" } }] }, { athletes: [athleteEntry(homePitcherId, "Home Pitcher", "RP")] }] },
          ]
        : [
            { team: { id: awayId }, statistics: [{ athletes: [] }, { athletes: [] }] },
            { team: { id: homeId }, statistics: [{ athletes: [] }, { athletes: [] }] },
          ],
    },
  };
}

function stubFetch({ summary, gamelogByPitcherId = {}, savantCsv = null }) {
  clearCache("mlb:");
  clearCache("savant:");
  globalThis.fetch = async (url) => {
    if (url.includes("/gamelog")) {
      const id = Object.keys(gamelogByPitcherId).find((pid) => url.includes(`/athletes/${pid}/`));
      return { ok: true, json: async () => gamelogByPitcherId[id] ?? { labels: [], statistics: [], events: {} } };
    }
    if (url.includes("baseballsavant.mlb.com")) {
      return { ok: true, text: async () => savantCsv ?? "not csv" };
    }
    return { ok: true, json: async () => summary };
  };
}

test("getMlbGameContext attaches confirmed role and lineup status to the correct side", async () => {
  const summary = summaryFixture({ homeId: "30", awayId: "21", homePitcherId: "42604", awayPitcherId: "4991251", confirmed: true });
  stubFetch({ summary });

  const ctx = await getMlbGameContext("evt-1");
  assert.equal(ctx.home.lineupConfirmed, true);
  assert.equal(ctx.away.lineupConfirmed, true);
  assert.equal(ctx.home.pitcher.confirmedRole, "RP");
  assert.equal(ctx.away.pitcher.confirmedRole, "SP");
  assert.equal(ctx.home.pitcher.name, "Home Pitcher");
  assert.equal(ctx.away.pitcher.name, "Away Pitcher");
});

test("getMlbGameContext leaves lineupConfirmed false and confirmedRole null when nothing has posted", async () => {
  const summary = summaryFixture({ homeId: "19", awayId: "24", homePitcherId: "1", awayPitcherId: "2", confirmed: false });
  stubFetch({ summary });

  const ctx = await getMlbGameContext("evt-2");
  assert.equal(ctx.home.lineupConfirmed, false);
  assert.equal(ctx.away.lineupConfirmed, false);
  assert.equal(ctx.home.pitcher.confirmedRole, null);
  assert.equal(ctx.away.pitcher.confirmedRole, null);
});

test("getMlbGameContext computes K-BB% from a matched Savant profile, per side", async () => {
  const summary = summaryFixture({ homeId: "30", awayId: "21", homePitcherId: "42604", awayPitcherId: "4991251", confirmed: true });
  const savantCsv = `"last_name, first_name","player_id","year","k_percent","bb_percent","whiff_percent"\n"Pitcher, Home",42604,2026,25,5,20\n`;
  stubFetch({ summary, savantCsv });

  const ctx = await getMlbGameContext("evt-3");
  assert.equal(ctx.home.pitcher.kMinusBBPercent, 20);
  // Away pitcher's name ("Away Pitcher") isn't in this Savant CSV — no match, never a guess.
  assert.equal(ctx.away.pitcher.kMinusBBPercent, null);
});

test("getMlbGameContext never throws when the summary fetch fails entirely", async () => {
  clearCache("mlb:");
  clearCache("savant:");
  globalThis.fetch = async () => {
    throw new Error("simulated ESPN outage");
  };
  const ctx = await getMlbGameContext("evt-4");
  assert.equal(ctx.home.lineupConfirmed, false);
  assert.equal(ctx.home.pitcher, null);
  assert.equal(ctx.away.pitcher, null);
});
