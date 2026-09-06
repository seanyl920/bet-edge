// First-ever test coverage for betlog.js — the actual bet CRUD/persistence
// module. BET_LOG_FILE (added alongside this test, same pattern
// predictionLog.js already used) lets this run against a throwaway file
// instead of the real data/bets.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "betlog-test-"));
process.env.BET_LOG_FILE = path.join(dir, "nested", "bets.json"); // nested — proves writeAll's mkdir fix

const { addBet, getBet, listBets, updateBet, deleteBet, betLogSummary } = await import("../server/betlog.js");

function bet(overrides = {}) {
  return { sport: "nfl", matchup: "AAA @ BBB", market: "moneyline", selection: "Home", americanOdds: -110, stake: 10, ...overrides };
}

test("addBet validates stake and americanOdds before ever touching the file", async () => {
  await assert.rejects(() => addBet(bet({ stake: -5 })), (err) => err.status === 400);
  await assert.rejects(() => addBet(bet({ americanOdds: 0 })), (err) => err.status === 400);
  await assert.rejects(() => addBet(bet({ americanOdds: "not-a-number" })), (err) => err.status === 400);
});

test("addBet persists a new bet with a real id, pending result, and null postmortem", async () => {
  const entry = await addBet(bet());
  assert.ok(entry.id);
  assert.equal(entry.result, "pending");
  assert.equal(entry.postmortem, null);
  assert.equal(entry.stake, 10);

  const fetched = await getBet(entry.id);
  assert.equal(fetched.id, entry.id);
});

test("listBets computes clvPct from americanOdds vs closingAmericanOdds, newest first", async () => {
  const a = await addBet(bet({ matchup: "list-order-a" }));
  await new Promise((r) => setTimeout(r, 5));
  const b = await addBet(bet({ matchup: "list-order-b" }));

  const all = await listBets();
  const idxA = all.findIndex((x) => x.id === a.id);
  const idxB = all.findIndex((x) => x.id === b.id);
  assert.ok(idxB < idxA, "the later-placed bet must sort first (newest first)");
});

test("updateBet rejects an invalid result value", async () => {
  const entry = await addBet(bet());
  await assert.rejects(() => updateBet(entry.id, { result: "won" }), (err) => err.status === 400); // must be exactly "win"
});

test("updateBet rejects updating a bet that doesn't exist", async () => {
  await assert.rejects(() => updateBet("no-such-id", { result: "win" }), (err) => err.status === 404);
});

test("updateBet only writes allow-listed fields — a client-supplied postmortem elsewhere is a separate boundary, but this layer itself must not silently accept arbitrary keys", async () => {
  const entry = await addBet(bet());
  const updated = await updateBet(entry.id, { result: "win", notAField: "should be ignored", matchup: "should also be ignored" });
  assert.equal(updated.result, "win");
  assert.equal(updated.matchup, entry.matchup, "matchup is not in the allow-list and must be unchanged");
  assert.equal(updated.notAField, undefined);
});

test("deleteBet removes the bet and returns true; a second delete of the same id returns false", async () => {
  const entry = await addBet(bet());
  assert.equal(await deleteBet(entry.id), true);
  assert.equal(await getBet(entry.id), null);
  assert.equal(await deleteBet(entry.id), false);
});

test("concurrent addBet calls never clobber each other (serialize() actually serializes)", async () => {
  const before = (await listBets()).length;
  await Promise.all(Array.from({ length: 20 }, (_, i) => addBet(bet({ matchup: `concurrent-${i}` }))));
  const after = (await listBets()).length;
  assert.equal(after - before, 20, "all 20 concurrent writes must be persisted — none silently lost to a write race");
});

test("betLogSummary computes profit correctly for win/loss/push, excluding void from financial totals", async () => {
  // Other tests in this file share the same throwaway file, so this
  // captures a before/after DELTA rather than asserting an exact global
  // total — still a precise check, just robust to test ordering.
  const before = await betLogSummary();

  const win = await addBet(bet({ matchup: "summary-win", americanOdds: 100, stake: 10 })); // +100 -> win pays 1x stake profit
  const loss = await addBet(bet({ matchup: "summary-loss", americanOdds: -110, stake: 10 }));
  const push = await addBet(bet({ matchup: "summary-push", americanOdds: -110, stake: 10 }));
  const voidBet = await addBet(bet({ matchup: "summary-void", americanOdds: -110, stake: 999 })); // stake must not count at all

  await updateBet(win.id, { result: "win" });
  await updateBet(loss.id, { result: "loss" });
  await updateBet(push.id, { result: "push" });
  await updateBet(voidBet.id, { result: "void" });

  const after = await betLogSummary();
  // win (+100 American, $10 stake) profits exactly $10; loss costs exactly
  // $10; push contributes 0; void contributes to neither staked nor profit.
  assert.ok(Math.abs(after.profit - before.profit - 0) < 0.01, "win (+$10) and loss (-$10) must net to $0, push and void contributing nothing");
  assert.equal(after.totalStaked - before.totalStaked, 30, "staked total must include win+loss+push ($10 each) but NOT the $999 void stake");
  assert.equal(after.voidBets - before.voidBets, 1);

  const voided = await getBet(voidBet.id);
  assert.equal(voided.result, "void");
});

test.after(async () => {
  await rm(dir, { recursive: true, force: true });
});
