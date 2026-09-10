import { test } from "node:test";
import assert from "node:assert/strict";
import { add, subtract } from "../lib/math.js";
import { main } from "../index.js";

test("add sums two numbers", () => {
  assert.equal(add(2, 3), 5);
});

test("subtract computes the difference", () => {
  assert.equal(subtract(5, 2), 3);
});

test("main returns add(2, 3)", () => {
  assert.equal(main(), 5);
});
