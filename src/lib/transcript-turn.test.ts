import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TURN_LIMITS,
  capTurn,
  endOfTurnDelayMs,
  lastSentences,
  isRevisionOf,
  latestUtterance,
  speechUnits,
  stripConsumedPrefix,
} from "./transcript-turn";
import { splitSentences } from "./caption-reconciler";

test("dots inside a name do not split a sentence", () => {
  assert.deepEqual(
    splitSentences("Do you know Node.js? We also use ASP.NET and v2.0 of it. Okay."),
    ["Do you know Node.js?", "We also use ASP.NET and v2.0 of it.", "Okay."]
  );
});

test("abbreviations and list markers are not sentence ends", () => {
  assert.deepEqual(splitSentences("Use a cache, e.g. Redis. Why?"), [
    "Use a cache, e.g. Redis.",
    "Why?",
  ]);
  assert.deepEqual(splitSentences("1. First point. 2. Second point."), [
    "1. First point.",
    "2. Second point.",
  ]);
});

test("CJK terminators split without needing a following space", () => {
  assert.deepEqual(splitSentences("你好吗？我很好。"), ["你好吗？", "我很好。"]);
});

test("lastSentences keeps whole sentences within the unit budget", () => {
  const text = "One two three four five. Six seven eight nine ten. Eleven twelve.";
  // 5 + 2 = 7 units fits a budget of 7, but not 6.
  assert.equal(lastSentences(text, 3, 7), "Six seven eight nine ten. Eleven twelve.");
  assert.equal(lastSentences(text, 3, 6), "Eleven twelve.");
  assert.equal(lastSentences(text, 2, 100), "Six seven eight nine ten. Eleven twelve.");
});

test("a single over-long sentence keeps its END, where the ask is", () => {
  const long = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ") + " why did you choose Kafka?";
  const out = capTurn(long, 20);
  assert.ok(out.endsWith("why did you choose Kafka?"));
  assert.ok(speechUnits(out) <= 20);
});

test("capTurn bounds a long unanswered backlog but keeps the newest ask", () => {
  const backlog = Array.from({ length: 80 }, (_, i) => `Filler sentence number ${i} goes here.`).join(" ");
  const out = capTurn(`${backlog} Tell me about a time you led a migration.`);
  assert.ok(speechUnits(out) <= TURN_LIMITS.turnMaxUnits);
  assert.ok(out.endsWith("Tell me about a time you led a migration."));
});

test("latestUtterance attaches the setup to a terse question", () => {
  assert.equal(
    latestUtterance("We run everything on Kubernetes across three regions. Why?"),
    "We run everything on Kubernetes across three regions. Why?"
  );
  assert.equal(
    latestUtterance(
      "We run everything on Kubernetes. Walk me through how you would design the deployment pipeline for it."
    ),
    "Walk me through how you would design the deployment pipeline for it."
  );
});

test("stripConsumedPrefix drops the already-answered leading words", () => {
  assert.equal(
    stripConsumedPrefix("Tell me about conflict. And how did you resolve it?", "Tell me about conflict."),
    "And how did you resolve it?"
  );
  assert.equal(stripConsumedPrefix("Brand new text", ""), "Brand new text");
});

test("end-of-turn: finished question is answered sooner than a base pause", () => {
  const q = endOfTurnDelayMs("How do you handle conflict on a team?", 1200);
  const s = endOfTurnDelayMs("Tell me about a time you led a project.", 1200);
  assert.ok(q !== null && s !== null && q < s);
  assert.equal(s, 1200);
});

test("end-of-turn: trailing off with no punctuation waits longer", () => {
  const unfinished = endOfTurnDelayMs("so what I would like to understand is how you", 1200);
  assert.equal(unfinished, 2400);
});

test("end-of-turn: bare filler never arms a timer, a one-word question does", () => {
  assert.equal(endOfTurnDelayMs("Okay.", 1200), null);
  assert.equal(endOfTurnDelayMs("Right so", 1200), null);
  assert.equal(endOfTurnDelayMs("", 1200), null);
  assert.notEqual(endOfTurnDelayMs("Why?", 1200), null);
});

test("a re-worded caption of already-answered speech is a revision, new speech is not", () => {
  const sent = "Tell me about a time you led a migration at your last company";
  assert.equal(isRevisionOf("Tell me about the time you led a migration at your last company", sent), true);
  assert.equal(isRevisionOf("And how did you handle the rollback plan there", sent), false);
  assert.equal(isRevisionOf("Why?", "Why?"), false);
});
