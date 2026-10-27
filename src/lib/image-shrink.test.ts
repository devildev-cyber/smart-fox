import test from "node:test";
import assert from "node:assert/strict";
import { fitWithin } from "./image-shrink";

test("fitWithin leaves small images alone", () => {
  assert.deepEqual(fitWithin(1280, 720, 1800), { width: 1280, height: 720 });
});

test("fitWithin scales the longest edge down and keeps the ratio", () => {
  assert.deepEqual(fitWithin(3840, 2160, 1800), { width: 1800, height: 1013 });
  assert.deepEqual(fitWithin(1000, 4000, 2000), { width: 500, height: 2000 });
});

test("fitWithin tolerates bad sizes", () => {
  assert.deepEqual(fitWithin(0, 0, 1800), { width: 0, height: 0 });
});
