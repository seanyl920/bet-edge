// First-ever test coverage for statFind.js — the defensive deep-search
// helpers used against ESPN's undocumented, loosely-shaped stat blobs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findStatValue, findStatIndex } from "../server/statFind.js";

test("findStatValue finds a matching stat by abbreviation, case-insensitively", () => {
  const node = { stats: [{ abbreviation: "era", value: 3.45 }] };
  assert.equal(findStatValue(node, ["ERA"]), 3.45);
});

test("findStatValue falls back to shortDisplayName or name when abbreviation is absent", () => {
  const byShortName = { name: "WHIP", displayValue: "1.12" };
  assert.equal(findStatValue(byShortName, ["WHIP"]), 1.12);
});

test("findStatValue searches arrays and nested objects recursively", () => {
  const node = { categories: [{ stats: [{ abbreviation: "K9", value: 9.1 }] }] };
  assert.equal(findStatValue(node, ["K9", "K/9"]), 9.1);
});

test("findStatValue matches any of several alias abbreviations", () => {
  const node = { abbreviation: "K/9", value: 8.5 };
  assert.equal(findStatValue(node, ["K9", "K/9", "SO9"]), 8.5);
});

test("findStatValue returns null (never 0 or a guess) when nothing matches", () => {
  const node = { abbreviation: "ERA", value: 3.45 };
  assert.equal(findStatValue(node, ["WHIP"]), null);
});

test("findStatValue returns null for a matched label whose value is an empty string or non-numeric, rather than NaN", () => {
  const node = { abbreviation: "ERA", value: "" };
  assert.equal(findStatValue(node, ["ERA"]), null);
});

test("findStatValue does not recurse forever on a circular-ish deep structure — depth-limited", () => {
  let deep = { abbreviation: "TARGET", value: 42 };
  for (let i = 0; i < 20; i++) deep = { wrapper: deep };
  // TARGET is buried more than 6 levels deep — must not be found (and must not throw/hang).
  assert.equal(findStatValue(deep, ["TARGET"]), null);
});

test("findStatValue handles null/undefined input without throwing", () => {
  assert.equal(findStatValue(null, ["ERA"]), null);
  assert.equal(findStatValue(undefined, ["ERA"]), null);
});

test("findStatIndex finds the index of a name, case-insensitively", () => {
  assert.equal(findStatIndex(["AB", "H", "HR", "RBI"], ["hr"]), 2);
});

test("findStatIndex tries aliases in order and returns the first match", () => {
  assert.equal(findStatIndex(["IP", "SO"], ["strikeouts", "SO", "K"]), 1);
});

test("findStatIndex returns -1 when nothing matches or names isn't an array", () => {
  assert.equal(findStatIndex(["AB", "H"], ["HR"]), -1);
  assert.equal(findStatIndex(null, ["HR"]), -1);
});
