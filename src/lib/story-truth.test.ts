import { test } from "node:test";
import assert from "node:assert/strict";
import { isToldByCandidate, toldDetails, toldEntry } from "./story-truth";
import { buildAnswerContext, selectContext, type StoryLike } from "./context";
import { positioningBriefSchema } from "./schemas";

const story = (over: Partial<StoryLike> & { id: string }): StoryLike => ({
  title: "",
  category: "signature_project",
  shortVersion: "",
  starVersion: "",
  technicalVersion: "",
  keywords: [],
  ...over,
});

test("told entries are detected and unwrapped, commas intact", () => {
  const evidence = ["Built Canvas", toldEntry("the pool hit max, and nobody noticed for a day")];
  assert.equal(isToldByCandidate(evidence), true);
  assert.deepEqual(toldDetails(evidence), ["the pool hit max, and nobody noticed for a day"]);
  assert.equal(isToldByCandidate(["Built Canvas"]), false);
  assert.equal(isToldByCandidate(undefined), false);
});

test("a story the candidate verified wins an otherwise-equal tie", () => {
  const plain = story({ id: "plain", title: "Kafka pipeline", keywords: ["kafka"] });
  const told = story({
    id: "told",
    title: "Kafka pipeline",
    keywords: ["kafka"],
    evidence: [toldEntry("replay saved us")],
  });
  const { stories } = selectContext({ question: "Tell me about Kafka", stories: [plain, told] });
  assert.equal(stories[0].id, "told");
});

test("a verified story is marked in the prompt and includes its technical version", () => {
  const told = story({
    id: "t",
    title: "Kafka pipeline",
    shortVersion: "Short.",
    starVersion: "Story.",
    technicalVersion: "Offsets and partitions.",
    evidence: [toldEntry("replay saved us")],
  });
  const ctx = buildAnswerContext({
    detectedQuestion: "Why Kafka?",
    recentTranscript: "",
    selected: { resumeFacts: [], jdRequirements: [], stories: [told] },
  });
  assert.match(ctx, /told by the candidate/);
  assert.match(ctx, /technical: Offsets and partitions\./);
});

test("brief projects keep their invented list, and old cached briefs still parse", () => {
  const withInvented = positioningBriefSchema.parse({
    signature_projects: [{ title: "Canvas", what: "x", invented: ["the name 'Canvas'"] }],
  });
  assert.deepEqual(withInvented.signature_projects[0].invented, ["the name 'Canvas'"]);

  // A brief cached before this field existed has no "invented" key at all.
  const legacy = positioningBriefSchema.parse({ signature_projects: [{ title: "Old", what: "y" }] });
  assert.deepEqual(legacy.signature_projects[0].invented, []);
});
