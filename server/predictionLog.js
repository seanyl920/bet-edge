// Prospective-evaluation infrastructure. Before this app can honestly claim
// any prediction is "improved" or "more profitable" than the previous
// model or the market — a real instruction this project now operates
// under — it needs a chronological record of what it predicted, written
// down BEFORE the outcome was known. The bet log alone can't serve that:
// it only has legs a user chose to bet, a small, self-selected sample that
// skews toward whatever already looked good. This logs every prediction
// this app actually PRICES (a real trueProb tied to a real market line),
// win or lose on the bet log, so a genuine hit-rate/calibration check can
// run later against every prediction this app made, not just the ones
// someone acted on.
//
// Append-only JSONL, not the read-modify-write-whole-file pattern
// betlog.js needs (which exists because bets get updated/deleted — a
// prediction snapshot never does; it's a one-time fact about what this app
// believed at a moment in time). Individual small appendFile() calls are
// effectively atomic at this size, so no serialize() mutex is needed here.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { localDateKey } from "./dateUtil.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
// Overridable so tests can point this at a throwaway file instead of the
// real prediction log — read once at module load, same pattern a real
// deployment never needs to touch.
const FILE = process.env.PREDICTION_LOG_FILE
  ? path.resolve(process.env.PREDICTION_LOG_FILE)
  : path.join(DATA_DIR, "predictionLog.jsonl");

// Bump this whenever the underlying prediction logic changes materially
// (a new data source, a different model), so a later evaluation can group
// results by which version of the model actually made them — comparing a
// pre-change hit rate against a post-change one is meaningless otherwise.
export const MODEL_VERSION = "v1-elo-streak-heuristic";

// Only log the FIRST prediction for a given (subject/market/side/point)
// per local calendar day, even though the functions that call this can run
// on every page load. Keyed in memory rather than checked against the file
// on every call — this process only ever runs one server, and the key
// space (today's real games/players) is small, so this never grows
// unbounded; a stale day's entry is simply overwritten, not cleaned up
// separately.
const loggedToday = new Map(); // dedupeKey -> localDateKey string

function dedupeKey(record) {
  return [record.sport, record.kind, record.subjectId, record.market, record.side ?? "", record.point ?? ""].join("|");
}

/**
 * Record one prediction, unless an identical one was already recorded
 * today. Never throws — a logging failure must never break the feed that
 * generated the prediction in the first place.
 *
 * `record` shape:
 *   sport, kind ("trend"|"edge"), subjectId, subjectName, market, side,
 *   point, predictedProb, marketProb, probSource,
 *   leg: { label, eventId, commenceTime, matchup, market, selection,
 *          americanOdds, sport, context }
 * `leg` is deliberately the exact same shape EdgeFeed.jsx/TrendFeed.jsx
 * build when a user adds a leg manually — so predictionEval.js can grade
 * it later by reusing postmortem.js's analyzeBet() unchanged, instead of
 * a second, parallel grading implementation that could drift from the
 * real one.
 */
export async function recordPrediction(record) {
  try {
    const key = dedupeKey(record);
    const today = localDateKey();
    if (loggedToday.get(key) === today) return;
    loggedToday.set(key, today);

    const line = {
      id: randomUUID(),
      recordedAt: new Date().toISOString(),
      modelVersion: MODEL_VERSION,
      ...record,
    };
    await mkdir(path.dirname(FILE), { recursive: true });
    await appendFile(FILE, JSON.stringify(line) + "\n");
  } catch (err) {
    console.warn(`[predictionLog] recordPrediction failed (non-fatal): ${err.message}`);
  }
}

/** Reads every recorded prediction. A malformed line is skipped, not fatal to the read. */
export async function readPredictionLog() {
  try {
    const raw = await readFile(FILE, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const records = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {
        // one bad line shouldn't lose every other one
      }
    }
    return records;
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}
