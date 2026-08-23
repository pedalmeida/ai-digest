import assert from "node:assert/strict";
import test from "node:test";
import { digestModel } from "./model-config.js";

test("uses Haiku 4.5 by default", () => {
  assert.equal(digestModel({}), "claude-haiku-4-5");
});

test("allows an explicit model override for controlled benchmarks", () => {
  assert.equal(digestModel({ ANTHROPIC_MODEL: "claude-sonnet-5" }), "claude-sonnet-5");
});
