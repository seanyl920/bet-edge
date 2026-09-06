// First-ever direct test coverage for edges.js's logEdgePrediction() —
// exported specifically so this can be checked without a full live
// getEdgeFeed() run. Written alongside a confirmed real bug (self-audit,
// Sept 2026): the logged leg's context.modelProb was set to the RAW
// (unblended) Elo estimate, inconsistent with the SAME context shape built
// by EdgeFeed.jsx and dailyParlay.js's edgeCandidates() (both correctly
// use the blended probability). postmortem.js's gradeEdgeLeg() reads
// ctx.modelProb to build its "Predicted: model X% vs market Y%" note when
// grading a predictionLog.jsonl record — with the old value, that note
// showed the wrong number: the raw Elo estimate, not the blended
// probability actually recorded as predictedProb and graded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "edgeslog-test-"));
process.env.PREDICTION_LOG_FILE = path.join(dir, "predictionLog.jsonl");

const { logEdgePrediction } = await import("../server/edges.js");
const { readPredictionLog } = await import("../server/predictionLog.js");

function futureCommenceTime(msFromNow = 60 * 60 * 1000) {
  return new Date(Date.now() + msFromNow).toISOString();
}

function edge(overrides = {}) {
  return {
    sport: "nfl",
    eventId: "evt-log-1",
    commenceTime: futureCommenceTime(),
    matchup: "AAA @ BBB",
    market: "moneyline",
    side: "home",
    team: "BBB",
    line: null,
    americanOdds: -150,
    modelProb: 0.7, // raw Elo — deliberately different from blendedProb below
    blendedProb: 0.6, // what's actually priced/graded
    marketProb: 0.55,
    sampleSize: 10,
    ...overrides,
  };
}

test("logEdgePrediction records predictedProb as the BLENDED probability, not raw Elo", async () => {
  await logEdgePrediction(edge());
  const records = await readPredictionLog();
  const record = records.find((r) => r.leg.eventId === "evt-log-1");
  assert.equal(record.predictedProb, 0.6);
});

test("logEdgePrediction's logged leg context.modelProb matches the BLENDED probability (predictedProb), not raw Elo — this is the confirmed bug", async () => {
  await logEdgePrediction(edge({ eventId: "evt-log-2" }));
  const records = await readPredictionLog();
  const record = records.find((r) => r.leg.eventId === "evt-log-2");
  assert.equal(
    record.leg.context.modelProb,
    0.6,
    "context.modelProb must be the blended probability actually used to price/grade this bet — matching EdgeFeed.jsx/dailyParlay.js's own convention for the same field"
  );
  assert.equal(record.leg.context.rawEloProb, 0.7, "the raw Elo estimate is still kept, just under its own distinct field");
});

test.after(async () => {
  await rm(dir, { recursive: true, force: true });
});
