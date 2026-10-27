import test from "node:test";
import assert from "node:assert/strict";
import { answersForCoding, codingForAnswers } from "./session-memory";
import type { CodingSolution } from "./coding";

function solution(over: Partial<CodingSolution> = {}): CodingSolution {
  return {
    mode: "new",
    problem: "Two Sum",
    say: "I'll use a hash map for O(1) lookups.",
    steps: [{ code: "seen = {}", narrate: "setup" }],
    language: "python",
    complexity: "Time O(n) · Space O(n)",
    points: "",
    note: "",
    error: null,
    ...over,
  };
}

test("answersForCoding reads oldest to newest and caps the count", () => {
  const log = [
    { question: "Q3", answer: "A3" },
    { question: "Q2", answer: "A2" },
    { question: "Q1", answer: "A1" },
  ];
  const text = answersForCoding(log, 2);
  assert.ok(text.indexOf("Q2") < text.indexOf("Q3"));
  assert.ok(!text.includes("Q1"));
});

test("answersForCoding flattens markdown and truncates long answers", () => {
  const text = answersForCoding([
    { question: "Q", answer: `**Bold** point\n- one\n- two ${"x".repeat(600)}` },
  ]);
  assert.ok(!text.includes("**"));
  assert.ok(text.endsWith("…"));
});

test("answersForCoding skips empty answers", () => {
  assert.equal(answersForCoding([{ question: "Q", answer: "  " }]), "");
});

test("codingForAnswers includes the final code only for the latest turn", () => {
  const older = { solution: solution({ problem: "Old problem", steps: [{ code: "OLDCODE", narrate: "" }] }) };
  const latest = { solution: solution({ problem: "New problem", steps: [{ code: "NEWCODE", narrate: "" }] }) };
  const text = codingForAnswers([latest, older]);
  assert.ok(text.includes("NEWCODE"));
  assert.ok(!text.includes("OLDCODE"));
  assert.ok(text.indexOf("Old problem") < text.indexOf("New problem"));
});

test("codingForAnswers ignores empty turns", () => {
  const empty = { solution: solution({ problem: "", say: "", steps: [] }) };
  assert.equal(codingForAnswers([empty]), "");
});
