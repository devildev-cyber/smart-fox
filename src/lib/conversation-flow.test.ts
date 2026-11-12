import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAnswerContext } from "./context";
import { generateAnswerRequestSchema } from "./schemas";
import { MASTER_ANSWER_PROMPT } from "./prompts";

const empty = { resumeFacts: [], jdRequirements: [], stories: [] };

test("without a typed line, the model gets the conversation tail and no extracted question", () => {
  const ctx = buildAnswerContext({
    detectedQuestion: "",
    recentTranscript: "We run everything on Kafka here. Honestly the team is small.",
    selected: empty,
  });
  assert.match(ctx, /CONVERSATION \(most recent last\):\nWe run everything on Kafka here/);
  assert.doesNotMatch(ctx, /QUESTION TO ANSWER|LATEST WORDS|EARLIER CONTEXT/);
});

test("a typed line is handed over as what the interviewer said", () => {
  const ctx = buildAnswerContext({
    detectedQuestion: "Why Kafka?",
    recentTranscript: "earlier talk",
    selected: empty,
  });
  assert.match(ctx, /THE INTERVIEWER JUST SAID \(typed or summarized\):\nWhy Kafka\?/);
  assert.match(ctx, /CONVERSATION SO FAR \(context only\):\nearlier talk/);
});

test("manual requests are the default and a transcript alone is a valid request", () => {
  const req = generateAnswerRequestSchema.parse({ recentTranscript: "Tell me about yourself." });
  assert.equal(req.auto, false);
  assert.throws(() => generateAnswerRequestSchema.parse({}));
});

test("the prompt frames a conversation and only allows silence in AUTO mode", () => {
  assert.match(MASTER_ANSWER_PROMPT, /CONVERSATION, NOT A QUIZ/);
  assert.match(MASTER_ANSWER_PROMPT, /MANUAL[^\n]*ALWAYS reply/);
  assert.match(MASTER_ANSWER_PROMPT, /AUTO[^\n]*NO_ANSWER|AUTO \(triggered by a pause\)/);
});
