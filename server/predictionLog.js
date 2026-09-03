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

// Only log the FIRST prediction for a given (subject/event/market/side/
// point) per local calendar day, even though the functions that call this
// can run on every page load.
//
// Confirmed real bug (external review, Sept 2026), two parts:
// 1. This key omitted the event id entirely. Two DIFFERENT games with the
//    same player/market/side/point on the same calendar day — a
//    doubleheader is the obvious real case — collapsed into ONE record;
//    the second game's real, distinct prediction was silently dropped.
// 2. The in-memory Map was the ONLY dedup check, with nothing behind it —
//    a server restart lost it entirely, so the exact same prediction got
//    appended AGAIN on the next page load post-restart, producing true
//    duplicate rows in the file. Reproduced both live.
//
// Fixed: the key now includes the event id. For persistence across a
// restart, see ensureLoggedTodayLoaded() below — it lazily rebuilds this
// map from the file itself (not just memory) the first time this module is
// used in a process, so a restart can't forget what was already logged.
let loggedToday = null; // dedupeKey -> localDateKey string, once loaded
let loadPromise = null;

function dedupeKey(record) {
  return [record.sport, record.kind, record.subjectId, record.leg?.eventId ?? "", record.market, record.side ?? "", record.point ?? ""].join("|");
}

// Reads the existing log (if any) once per process and seeds `loggedToday`
// from it, so a restart doesn't forget what was already recorded today.
// Concurrent first-callers share one load via `loadPromise` (same pattern
// cache.js uses for in-flight fetches) rather than each re-reading the file.
async function ensureLoggedTodayLoaded() {
  if (loggedToday) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      const map = new Map();
      try {
        const existing = await readPredictionLog();
        for (const rec of existing) {
          const key = dedupeKey(rec);
          const day = localDateKey(rec.recordedAt);
          const currentDay = map.get(key);
          // localDateKey's YYYY-MM-DD format sorts lexicographically as
          // dates, so a plain string comparison finds the latest day for
          // a key that appears on more than one day across the file's
          // history.
          if (day && (!currentDay || day > currentDay)) map.set(key, day);
        }
      } catch {
        // Best-effort — if the file can't be read for some reason, start
        // from an empty map rather than block logging entirely.
      }
      loggedToday = map;
    })();
  }
  await loadPromise;
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
    // Confirmed real bug (external review, Sept 2026): nothing checked
    // whether the game had already started before logging a "pregame"
    // prediction. Every caller filters to STATUS_SCHEDULED before pricing
    // anything, but that scoreboard read is cached for up to 5 minutes
    // (see espn.js) — a game that started 2 minutes ago can still read as
    // "scheduled." Reproduced: a prediction for an already-started game
    // got recorded successfully. This dataset exists specifically to
    // compare PREGAME model/market beliefs against real outcomes; a
    // snapshot taken after first pitch could already reflect in-play
    // information, which would make any resulting hit-rate/calibration
    // number meaningless. The actual scheduled commence time (already
    // captured on every record) is a hard fact independent of any cached
    // status field — reject when it's already passed, rather than trust a
    // possibly-stale "scheduled" read. This does mean a real rain delay
    // that pushes first pitch back could cost a few legitimate late
    // snapshots — an acceptable trade for never letting in-play
    // information into a "pregame" dataset.
    const commenceMs = record?.leg?.commenceTime ? new Date(record.leg.commenceTime).getTime() : NaN;
    if (!Number.isNaN(commenceMs) && Date.now() >= commenceMs) {
      console.warn(`[predictionLog] recordPrediction skipped a post-start snapshot (commenceTime ${record.leg.commenceTime} already passed).`);
      return;
    }

    await ensureLoggedTodayLoaded();
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
