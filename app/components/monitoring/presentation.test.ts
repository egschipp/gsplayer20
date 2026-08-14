import assert from "node:assert/strict";
import test from "node:test";
import { clamp01, pillClass, toneClass } from "./presentation";

test("clamps monitoring meters to a valid ratio", () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(0.4), 0.4);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(Number.NaN), 0);
});

test("maps monitoring tones to stable visual classes", () => {
  assert.equal(toneClass("warn"), "ops-tone-warn");
  assert.equal(pillClass("ok"), "pill pill-success");
  assert.equal(pillClass("error"), "pill pill-error");
});
