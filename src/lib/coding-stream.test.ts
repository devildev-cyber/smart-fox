import test from "node:test";
import assert from "node:assert/strict";
import { ContinuationFilter } from "./coding-stream";
import { isProModel, liveCodingModel } from "./model-utils";

function run(chunks: string[]): string {
  const f = new ContinuationFilter();
  let out = "";
  for (const c of chunks) out += f.push(c);
  return out + f.flush();
}

test("filter drops repeated talk-track markers and starts at the first step", () => {
  const out = run([
    "@@MODE@@ new\n@@PROBLEM@@ two sum\n@@SAY@@\nI'll use a map.\n",
    "@@STEP@@ python\ndef f(): pass\n@@NARRATE@@\nsetup\n",
  ]);
  assert.ok(out.startsWith("@@STEP@@ python"));
  assert.ok(!out.includes("@@MODE@@"));
  assert.ok(!out.includes("@@SAY@@"));
});

test("filter handles a marker split across chunks", () => {
  const out = run(["@@SAY@@\nhello\n@@ST", "EP@@ python\nx = 1\n"]);
  assert.equal(out, "@@STEP@@ python\nx = 1\n");
});

test("filter passes everything through once open", () => {
  const f = new ContinuationFilter();
  assert.equal(f.push("@@STEP@@\ncode\n"), "@@STEP@@\ncode\n");
  assert.equal(f.push("@@MODE@@ odd\n"), "@@MODE@@ odd\n");
  assert.equal(f.flush(), "");
});

test("verbal modes start at POINTS", () => {
  const out = run(["@@MODE@@ answer\n@@SAY@@\nit is O(n)\n@@POINTS@@\n- a\n- b\n"]);
  assert.ok(out.startsWith("@@POINTS@@"));
});

test("a marker mid-line is not treated as a boundary", () => {
  const out = run(["@@SAY@@\nwe use @@STEP@@ later\n@@STEP@@\ncode\n"]);
  assert.equal(out, "@@STEP@@\ncode\n");
});

test("plain prose with no markers is kept as POINTS, not lost", () => {
  const out = run(["Use a heap. ", "It is O(n log k)."]);
  assert.equal(out, "@@POINTS@@\nUse a heap. It is O(n log k).");
});

test("nothing at all yields nothing", () => {
  assert.equal(run([]), "");
});

test("live coding swaps pro models for their base model", () => {
  assert.equal(liveCodingModel("gpt-5.5-pro"), "gpt-5.5");
  assert.equal(liveCodingModel("o3-pro"), "o3");
  assert.equal(liveCodingModel("gpt-5.5"), "gpt-5.5");
  assert.equal(liveCodingModel("gpt-5-mini"), "gpt-5-mini");
  assert.ok(isProModel("gpt-5-pro"));
  assert.ok(!isProModel("gpt-5"));
});
