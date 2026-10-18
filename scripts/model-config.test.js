import assert from "node:assert/strict";
import test from "node:test";
import { digestModel } from "./model-config.js";

test("uses Claude Opus 5 by default", () => {
  assert.equal(digestModel({}), "claude-opus-5");
});

test("allows an explicit model override for controlled benchmarks", () => {
  assert.equal(digestModel({ ANTHROPIC_MODEL: "claude-sonnet-5" }), "claude-sonnet-5");
});
