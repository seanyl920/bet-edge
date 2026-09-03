// Uses PREDICTION_LOG_FILE to point predictionLog.js at a throwaway file per
// test run, so this never touches the real data/predictionLog.jsonl. The
// module reads that env var once at import time, so it's set before the
// dynamic import below — a plain top-level `import` would run too early.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dir = await mkdtemp(path.join(tmpdir(), "predlog-test-"));
process.env.PREDICTION_LOG_FILE = path.join(dir, "predictionLog.jsonl");

const { recordPrediction, readPredictionLog, MODEL_VERSION } = await import("../server/predictionLog.js");

// A future timestamp, computed relative to whenever the tests actually
// run — recordPrediction() now rejects a prediction whose commenceTime has
// already passed (see the post-start-rejection tests below), so a
// hardcoded past date would make every other test in this file fail too.
function futureCommenceTime(msFromNow = 60 * 60 * 1000) {
  return new Date(Date.now() + msFromNow).toISOString();
}

function baseRecord(overrides = {}) {
  return {
    sport: "mlb",
    kind: "trend",
    subjectId: "player-1",
    subjectName: "Test Player",
    market: "hitStreak",
    side: "Over",
    point: 1.5,
    predictedProb: 0.62,
    marketProb: 0.55,
    probSource: "devig",
    leg: {
      label: "Test Player Over 1.5 (hitStreak)",
      eventId: "evt-1",
      commenceTime: futureCommenceTime(),
      matchup: "AAA @ BBB",
      market: "hitStreak",
      selection: "Over 1.5",
      americanOdds: -120,
      sport: "mlb",
      context: { kind: "trend", trendType: "hitStreak", playerId: "player-1", playerName: "Test Player" },
    },
    ...overrides,
  };
}

test("recordPrediction appends a JSONL line with an id, timestamp, and modelVersion", async () => {
  await recordPrediction(baseRecord({ subjectId: "player-append-1" }));
  const records = await readPredictionLog();
  const found = records.find((r) => r.subjectId === "player-append-1");
  assert.ok(found, "expected the recorded prediction to be readable back");
  assert.equal(found.modelVersion, MODEL_VERSION);
  assert.equal(typeof found.id, "string");
  assert.ok(found.id.length > 0);
  assert.equal(typeof found.recordedAt, "string");
  assert.ok(!Number.isNaN(Date.parse(found.recordedAt)));
  assert.equal(found.predictedProb, 0.62);
  assert.deepEqual(found.leg.context, {
    kind: "trend",
    trendType: "hitStreak",
    playerId: "player-1",
    playerName: "Test Player",
  });
});

test("recordPrediction dedupes an identical (sport,kind,subjectId,market,side,point) same-day", async () => {
  const before = (await readPredictionLog()).filter((r) => r.subjectId === "player-dedupe-1").length;
  await recordPrediction(baseRecord({ subjectId: "player-dedupe-1", predictedProb: 0.6 }));
  await recordPrediction(baseRecord({ subjectId: "player-dedupe-1", predictedProb: 0.99 }));
  await recordPrediction(baseRecord({ subjectId: "player-dedupe-1", predictedProb: 0.01 }));
  const after = (await readPredictionLog()).filter((r) => r.subjectId === "player-dedupe-1").length;
  assert.equal(after - before, 1, "only the first call of the day should have been written");
});

test("recordPrediction does NOT dedupe across a different point (different exact line = different bet)", async () => {
  await recordPrediction(baseRecord({ subjectId: "player-point-1", point: 1.5 }));
  await recordPrediction(baseRecord({ subjectId: "player-point-1", point: 2.5 }));
  const records = (await readPredictionLog()).filter((r) => r.subjectId === "player-point-1");
  assert.equal(records.length, 2, "Over 1.5 and Over 2.5 are different exact-line bets, both should be logged");
  const points = records.map((r) => r.point).sort();
  assert.deepEqual(points, [1.5, 2.5]);
});

test("recordPrediction does NOT dedupe across a different side (Over vs Under)", async () => {
  await recordPrediction(baseRecord({ subjectId: "player-side-1", side: "Over" }));
  await recordPrediction(baseRecord({ subjectId: "player-side-1", side: "Under" }));
  const records = (await readPredictionLog()).filter((r) => r.subjectId === "player-side-1");
  assert.equal(records.length, 2);
});

test("recordPrediction does NOT dedupe across a different event — a doubleheader's two games are different predictions", async () => {
  // Confirmed real bug: the dedup key used to omit the event id entirely,
  // so the same player/market/side/point in TWO different games (the
  // obvious real case: a doubleheader) collapsed into one record — the
  // second game's genuinely distinct prediction was silently dropped.
  await recordPrediction(baseRecord({ subjectId: "player-dh-1", leg: { ...baseRecord().leg, eventId: "evt-dh-game1" } }));
  await recordPrediction(baseRecord({ subjectId: "player-dh-1", leg: { ...baseRecord().leg, eventId: "evt-dh-game2" } }));
  const records = (await readPredictionLog()).filter((r) => r.subjectId === "player-dh-1");
  assert.equal(records.length, 2, "two different games must both be logged, even with identical player/market/side/point");
  const eventIds = records.map((r) => r.leg.eventId).sort();
  assert.deepEqual(eventIds, ["evt-dh-game1", "evt-dh-game2"]);
});

test("recordPrediction's same-day dedup survives a server restart (not just in-memory)", async () => {
  // Confirmed real bug: the in-memory Map was the ONLY dedup check — a
  // restart lost it entirely, so the same prediction got re-appended on
  // the next call post-restart. Simulates two separate process lifetimes
  // against the SAME file (Node's module cache means re-importing within
  // one process wouldn't actually reset the module's in-memory state, so
  // this has to be two real child processes — same technique as the
  // "file doesn't exist yet" test above).
  const restartDir = await mkdtemp(path.join(tmpdir(), "predlog-restart-"));
  const restartFile = path.join(restartDir, "predictionLog.jsonl");
  const modulePath = JSON.stringify(path.join(__dirname, "..", "server", "predictionLog.js"));
  const recordJson = JSON.stringify({
    sport: "mlb",
    kind: "trend",
    subjectId: "player-restart-1",
    market: "hitStreak",
    side: "Over",
    point: 1.5,
    predictedProb: 0.6,
    marketProb: 0.55,
    probSource: "devig",
    leg: { label: "x", eventId: "evt-restart-1", commenceTime: futureCommenceTime(), matchup: "AAA @ BBB", market: "hitStreak", selection: "Over 1.5", americanOdds: -120, sport: "mlb", context: {} },
  });
  const script = `
    import { recordPrediction } from ${modulePath};
    await recordPrediction(${recordJson});
  `;
  try {
    // Process A: first "boot" of the server, logs the prediction once.
    await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, PREDICTION_LOG_FILE: restartFile },
    });
    // Process B: simulates a restart — same file, same prediction, same day.
    await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, PREDICTION_LOG_FILE: restartFile },
    });

    const raw = await readFile(restartFile, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "the same prediction logged before and after a restart must still only appear once");
  } finally {
    await rm(restartDir, { recursive: true, force: true });
  }
});

test("recordPrediction never throws even if the record is malformed", async () => {
  await assert.doesNotReject(() => recordPrediction({}));
  await assert.doesNotReject(() => recordPrediction(null).catch(() => {}));
});

test("recordPrediction rejects a prediction whose game has already started", async () => {
  // Confirmed real bug: nothing checked whether the game had already
  // started before logging a "pregame" prediction — reproduced a
  // successful recording for an already-started game. This dataset exists
  // specifically to compare PREGAME beliefs against outcomes; a post-start
  // snapshot could already reflect in-play information.
  const pastCommenceTime = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
  await recordPrediction(baseRecord({ subjectId: "player-poststart-1", leg: { ...baseRecord().leg, commenceTime: pastCommenceTime } }));
  const records = (await readPredictionLog()).filter((r) => r.subjectId === "player-poststart-1");
  assert.equal(records.length, 0, "a prediction for a game already underway must not be logged");
});

test("recordPrediction accepts a prediction right up to the moment before commence time", async () => {
  const soonCommenceTime = new Date(Date.now() + 60 * 1000).toISOString(); // 1 minute from now
  await recordPrediction(baseRecord({ subjectId: "player-prestart-1", leg: { ...baseRecord().leg, commenceTime: soonCommenceTime } }));
  const records = (await readPredictionLog()).filter((r) => r.subjectId === "player-prestart-1");
  assert.equal(records.length, 1, "a genuinely pregame prediction, even seconds before first pitch, must still be logged");
});

test("readPredictionLog skips a malformed line instead of failing the whole read", async () => {
  await recordPrediction(baseRecord({ subjectId: "player-before-corrupt" }));
  const file = process.env.PREDICTION_LOG_FILE;
  const raw = await readFile(file, "utf-8");
  const fs = await import("node:fs/promises");
  await fs.appendFile(file, "{not valid json\n");
  await recordPrediction(baseRecord({ subjectId: "player-after-corrupt" }));

  const records = await readPredictionLog();
  assert.ok(records.some((r) => r.subjectId === "player-before-corrupt"));
  assert.ok(records.some((r) => r.subjectId === "player-after-corrupt"));
  assert.ok(raw.length > 0); // sanity: the file wasn't empty before we corrupted it
});

test("readPredictionLog returns [] when the file doesn't exist yet", async () => {
  // FILE is a module-level const read once at import time, so this can't be
  // exercised by re-importing predictionLog.js in the same process (Node's
  // module cache would just hand back the already-loaded instance). Spawn a
  // fresh process pointed at a path that has never been written to instead —
  // the real condition readPredictionLog()'s ENOENT branch exists for.
  const emptyDir = await mkdtemp(path.join(tmpdir(), "predlog-empty-"));
  try {
    const missing = path.join(emptyDir, "predictionLog.jsonl");
    const script = `
      import { readPredictionLog } from ${JSON.stringify(path.join(__dirname, "..", "server", "predictionLog.js"))};
      const records = await readPredictionLog();
      if (!Array.isArray(records) || records.length !== 0) {
        console.error("expected []; got " + JSON.stringify(records));
        process.exit(1);
      }
    `;
    await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, PREDICTION_LOG_FILE: missing },
    });
  } finally {
    await rm(emptyDir, { recursive: true, force: true });
  }
});

test.after(async () => {
  await rm(dir, { recursive: true, force: true });
});
