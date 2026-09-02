// Bet log persistence: a flat JSON file. This is a single-user personal
// tool, so a database is overkill — a file is easy to inspect, back up, and
// diff. Swap for a real DB if this ever needs to support multiple users.
//
// Every mutation still does read-whole-file -> modify -> write-whole-file,
// which is fine for a file this small, but two things about that needed
// hardening once a real reviewer looked at it: overlapping requests could
// race (the later write clobbering the earlier one, since both read the
// same pre-mutation state), and a crash mid-write could leave truncated,
// unreadable JSON. `serialize()` below closes the first (every mutation
// queues behind the previous one, within this process — there's only ever
// one `node server/index.js` process for this app, so process-level
// serialization is sufficient); `writeAll`'s temp-file-then-rename closes
// the second (a rename is atomic on the same filesystem, so readers only
// ever see either the old complete file or the new complete file, never a
// half-written one).

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { americanToDecimal } from "./oddsMath.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "bets.json");

const RESULT_VALUES = new Set(["pending", "win", "loss", "push", "void"]);
// win/loss/push affect staked/profit/ROI; void is a finished bet with
// nothing at risk (money back), so it's excluded from those but should
// still count as settled, not pending — see README's Known-issue history.
const FINANCIAL_RESULTS = new Set(["win", "loss", "push"]);
const FINALIZED_RESULTS = new Set(["win", "loss", "push", "void"]);

let writeQueue = Promise.resolve();
/** Runs fn() after every previously-queued mutation has finished, regardless of whether they threw. */
function serialize(fn) {
  const result = writeQueue.then(fn, fn);
  writeQueue = result.then(
    () => {},
    () => {}
  );
  return result;
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

async function readAll() {
  try {
    const raw = await readFile(FILE, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function writeAll(bets) {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(bets, null, 2));
  await rename(tmp, FILE); // atomic on the same filesystem
}

/** Closing-line value: how much better (or worse) your price was vs. the closing price, in %. */
function computeClv(americanOddsTaken, americanOddsClose) {
  if (americanOddsTaken == null || americanOddsClose == null) return null;
  const yourDecimal = americanToDecimal(americanOddsTaken);
  const closeDecimal = americanToDecimal(americanOddsClose);
  if (!yourDecimal || !closeDecimal) return null;
  return Math.round((yourDecimal / closeDecimal - 1) * 10000) / 100; // %
}

function validateStake(stake) {
  const n = Number(stake);
  if (!Number.isFinite(n) || n < 0) throw badRequest("stake must be a finite number >= 0");
  return n;
}

function validateAmericanOdds(odds, field = "americanOdds") {
  const n = Number(odds);
  if (!Number.isFinite(n) || n === 0) throw badRequest(`${field} must be a finite nonzero number`);
  return n;
}

/** Raw bet record (no CLV mapping) — used by the postmortem engine, which needs the full `legs` array. */
export async function getBet(id) {
  const bets = await readAll();
  return bets.find((b) => b.id === id) ?? null;
}

export async function listBets() {
  const bets = await readAll();
  return bets
    .map((b) => ({ ...b, clvPct: computeClv(b.americanOdds, b.closingAmericanOdds) }))
    .sort((a, b) => new Date(b.placedAt) - new Date(a.placedAt));
}

export async function addBet(bet) {
  const stake = validateStake(bet.stake);
  const americanOdds = validateAmericanOdds(bet.americanOdds);

  return serialize(async () => {
    const bets = await readAll();
    const entry = {
      id: randomUUID(),
      placedAt: new Date().toISOString(),
      sport: bet.sport,
      eventId: bet.eventId ?? null,
      matchup: bet.matchup ?? null,
      market: bet.market ?? null,
      selection: bet.selection ?? null,
      americanOdds,
      stake,
      modelProb: bet.modelProb ?? null,
      legs: bet.legs ?? null, // present for parlays
      closingAmericanOdds: null,
      result: "pending",
      postmortem: null, // filled in by analyzeBet() once the bet is settled — see postmortem.js
    };
    bets.push(entry);
    await writeAll(bets);
    return entry;
  });
}

/**
 * `postmortem` is intentionally accepted here (analyzeBet's internal caller
 * needs to set it) but the public PATCH route in index.js never forwards a
 * client-supplied `postmortem` — that boundary is where this app draws the
 * line between "trusted internal write" and "arbitrary external input,"
 * since unvalidated postmortem data would otherwise feed straight into the
 * calibration engine.
 */
export async function updateBet(id, patch) {
  if ("result" in patch && !RESULT_VALUES.has(patch.result)) {
    throw badRequest(`result must be one of: ${[...RESULT_VALUES].join(", ")}`);
  }
  const validated = { ...patch };
  if ("stake" in patch) validated.stake = validateStake(patch.stake);
  if ("closingAmericanOdds" in patch && patch.closingAmericanOdds != null) {
    validated.closingAmericanOdds = validateAmericanOdds(patch.closingAmericanOdds, "closingAmericanOdds");
  }

  return serialize(async () => {
    const bets = await readAll();
    const idx = bets.findIndex((b) => b.id === id);
    if (idx === -1) {
      const err = new Error("bet not found");
      err.status = 404;
      throw err;
    }
    const allowed = ["closingAmericanOdds", "result", "stake", "postmortem"];
    for (const key of allowed) {
      if (key in validated) bets[idx][key] = validated[key];
    }
    await writeAll(bets);
    return bets[idx];
  });
}

export async function deleteBet(id) {
  return serialize(async () => {
    const bets = await readAll();
    const next = bets.filter((b) => b.id !== id);
    await writeAll(next);
    return next.length !== bets.length;
  });
}

export async function betLogSummary() {
  const bets = await listBets();
  const financial = bets.filter((b) => FINANCIAL_RESULTS.has(b.result));
  const finalized = bets.filter((b) => FINALIZED_RESULTS.has(b.result));

  const staked = financial.reduce((s, b) => s + b.stake, 0);
  const profit = financial.reduce((s, b) => {
    if (b.result === "push") return s;
    if (b.result === "win") return s + b.stake * (americanToDecimal(b.americanOdds) - 1);
    return s - b.stake;
  }, 0);
  const clvValues = bets.map((b) => b.clvPct).filter((v) => v != null);
  return {
    totalBets: bets.length,
    settledBets: finalized.length,
    pendingBets: bets.length - finalized.length,
    voidBets: bets.filter((b) => b.result === "void").length,
    totalStaked: Math.round(staked * 100) / 100,
    profit: Math.round(profit * 100) / 100,
    roiPct: staked > 0 ? Math.round((profit / staked) * 10000) / 100 : null,
    avgClvPct: clvValues.length
      ? Math.round((clvValues.reduce((s, v) => s + v, 0) / clvValues.length) * 100) / 100
      : null,
  };
}
