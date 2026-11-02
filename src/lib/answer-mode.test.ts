import { test } from "node:test";
import assert from "node:assert/strict";
import { generateAnswerRequestSchema } from "./schemas";
import { ANSWER_MODE_INSTRUCTIONS, buildAnswerSystemPrompt } from "./prompts";

const parse = (answerMode?: unknown) =>
  generateAnswerRequestSchema.parse({ detectedQuestion: "Why Kafka?", answerMode }).answerMode;

test("answer mode: brief is the default and old saved modes are mapped", () => {
  assert.equal(parse(undefined), "brief");
  assert.equal(parse("default"), "brief");
  assert.equal(parse("human"), "brief");
  assert.equal(parse("shorter"), "brief");
  assert.equal(parse("deep"), "deep");
  assert.equal(parse("technical"), "deep");
});

test("answer mode: only brief and deep exist, each with a hard word ceiling", () => {
  assert.deepEqual(Object.keys(ANSWER_MODE_INSTRUCTIONS).sort(), ["brief", "deep"]);
  assert.match(ANSWER_MODE_INSTRUCTIONS.brief, /never more than 70 words/);
  assert.match(ANSWER_MODE_INSTRUCTIONS.deep, /never more than 160 words/);
});

test("answer prompt: plain spoken text, no bullets, no per-answer length knobs", () => {
  const prompt = buildAnswerSystemPrompt(false, true);
  assert.match(prompt, /no bullets, no headings/);
  assert.doesNotMatch(prompt, /Hard length cap/);
});
