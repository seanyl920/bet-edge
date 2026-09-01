// Bet log persistence: a flat JSON file. This is a single-user personal
// tool, so a database is overkill — a file is easy to inspect, back up, and
// diff. Swap for a real DB if this ever needs to support multiple users.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { americanToDecimal } from "./oddsMath.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "bets.json");

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
  await writeFile(FILE, JSON.stringify(bets, null, 2));
}

/** Closing-line value: how much better (or worse) your price was vs. the closing price, in %. */
function computeClv(americanOddsTaken, americanOddsClose) {
  if (americanOddsTaken == null || americanOddsClose == null) return null;
  const yourDecimal = americanToDecimal(americanOddsTaken);
  const closeDecimal = americanToDecimal(americanOddsClose);
  if (!yourDecimal || !closeDecimal) return null;
  return Math.round((yourDecimal / closeDecimal - 1) * 10000) / 100; // %
}

export async function listBets() {
  const bets = await readAll();
  return bets
    .map((b) => ({ ...b, clvPct: computeClv(b.americanOdds, b.closingAmericanOdds) }))
    .sort((a, b) => new Date(b.placedAt) - new Date(a.placedAt));
}

export async function addBet(bet) {
  const bets = await readAll();
  const entry = {
    id: randomUUID(),
    placedAt: new Date().toISOString(),
    sport: bet.sport,
    eventId: bet.eventId ?? null,
    matchup: bet.matchup ?? null,
    market: bet.market ?? null,
    selection: bet.selection ?? null,
    americanOdds: bet.americanOdds,
    stake: Number(bet.stake) || 0,
    modelProb: bet.modelProb ?? null,
    legs: bet.legs ?? null, // present for parlays
    closingAmericanOdds: null,
    result: "pending", // pending | win | loss | push | void
  };
  bets.push(entry);
  await writeAll(bets);
  return entry;
}

export async function updateBet(id, patch) {
  const bets = await readAll();
  const idx = bets.findIndex((b) => b.id === id);
  if (idx === -1) {
    const err = new Error("bet not found");
    err.status = 404;
    throw err;
  }
  const allowed = ["closingAmericanOdds", "result", "stake"];
  for (const key of allowed) {
    if (key in patch) bets[idx][key] = patch[key];
  }
  await writeAll(bets);
  return bets[idx];
}

export async function deleteBet(id) {
  const bets = await readAll();
  const next = bets.filter((b) => b.id !== id);
  await writeAll(next);
  return next.length !== bets.length;
}

export async function betLogSummary() {
  const bets = await listBets();
  const settled = bets.filter((b) => b.result === "win" || b.result === "loss" || b.result === "push");
  const staked = settled.reduce((s, b) => s + b.stake, 0);
  const profit = settled.reduce((s, b) => {
    if (b.result === "push" || b.result === "void") return s;
    if (b.result === "win") return s + b.stake * (americanToDecimal(b.americanOdds) - 1);
    return s - b.stake;
  }, 0);
  const clvValues = bets.map((b) => b.clvPct).filter((v) => v != null);
  return {
    totalBets: bets.length,
    settledBets: settled.length,
    pendingBets: bets.length - settled.length,
    totalStaked: Math.round(staked * 100) / 100,
    profit: Math.round(profit * 100) / 100,
    roiPct: staked > 0 ? Math.round((profit / staked) * 10000) / 100 : null,
    avgClvPct: clvValues.length
      ? Math.round((clvValues.reduce((s, v) => s + v, 0) / clvValues.length) * 100) / 100
      : null,
  };
}
