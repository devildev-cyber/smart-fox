import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodingStream, hasCodingContent } from "./coding";

const FULL = [
  "@@MODE@@ new",
  "@@SAY@@",
  "I'll use a hash map so lookups are O(1); one pass and I'm done.",
  "@@CODE@@ python",
  "def two_sum(nums, target):",
  "    seen = {}  # value -> index",
  "    for i, n in enumerate(nums):",
  "        if target - n in seen:",
  "            return [seen[target - n], i]",
  "        seen[n] = i",
  "@@COMPLEXITY@@",
  "Time O(n) · Space O(n)",
  "@@PLAN@@",
  "- Store each value's index as we scan",
  "- Check for the complement before inserting",
  "@@NOTE@@",
  "If they want it sorted, mention two pointers.",
].join("\n");

test("parses all sections of a complete coding stream", () => {
  const s = parseCodingStream(FULL);
  assert.equal(s.mode, "new");
  assert.equal(s.language, "python");
  assert.equal(s.say, "I'll use a hash map so lookups are O(1); one pass and I'm done.");
  assert.match(s.code, /def two_sum/);
  assert.match(s.code, /seen\[n\] = i$/);
  assert.equal(s.complexity, "Time O(n) · Space O(n)");
  assert.match(s.plan, /Store each value/);
  assert.equal(s.note, "If they want it sorted, mention two pointers.");
  assert.equal(s.error, null);
});

test("preserves code indentation exactly", () => {
  const s = parseCodingStream(FULL);
  assert.ok(s.code.includes("    seen = {}  # value -> index"));
  assert.ok(s.code.includes("        if target - n in seen:"));
});

test("renders early tokens before the first marker under SAY", () => {
  const s = parseCodingStream("Let me think about this");
  assert.equal(s.say, "Let me think about this");
  assert.ok(hasCodingContent(s));
});

test("hides a partially-streamed trailing marker", () => {
  const partial = ["@@MODE@@ fix", "@@SAY@@", "Off-by-one on the loop bound.", "@@CO"].join(
    "\n"
  );
  const s = parseCodingStream(partial);
  assert.equal(s.mode, "fix");
  assert.equal(s.say, "Off-by-one on the loop bound.");
  // The dangling "@@CO" must not leak into any body.
  assert.ok(!s.say.includes("@@CO"));
});

test("invalid mode value resolves to null", () => {
  const s = parseCodingStream("@@MODE@@ banana\n@@SAY@@\nhi");
  assert.equal(s.mode, null);
  assert.equal(s.say, "hi");
});

test("surfaces a mid-stream transport error", () => {
  const s = parseCodingStream(
    "@@MODE@@ new\n@@SAY@@\nStarting…\n\n---ERROR---\nThe model failed while streaming."
  );
  assert.equal(s.say, "Starting…");
  assert.equal(s.error, "The model failed while streaming.");
});

test("answer mode with no code leaves code empty", () => {
  const s = parseCodingStream(
    "@@MODE@@ answer\n@@SAY@@\nUse a message queue to decouple producers and consumers.\n@@PLAN@@\n- Buffering\n- Backpressure"
  );
  assert.equal(s.mode, "answer");
  assert.equal(s.code, "");
  assert.match(s.plan, /Backpressure/);
});

test("empty input yields an empty, content-free solution", () => {
  const s = parseCodingStream("");
  assert.equal(hasCodingContent(s), false);
  assert.equal(s.error, null);
});
