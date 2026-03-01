import assert from "node:assert/strict";
import test from "node:test";
import { BREAKPOINTS, resolveBreakpoint } from "./breakpoints";
import {
  computeTrackListHeight,
  isCompactTrackLayout,
  resolveTrackHeaderClass,
  TRACK_LIST_HEIGHT_MAX,
  TRACK_LIST_HEIGHT_MIN,
} from "./layout";
import { createViewportTestSnapshot } from "./viewportStore";

test("resolveBreakpoint returns expected keys around threshold edges", () => {
  assert.equal(resolveBreakpoint(0), "base");
  assert.equal(resolveBreakpoint(BREAKPOINTS.mobile), "mobile");
  assert.equal(resolveBreakpoint(BREAKPOINTS.tablet), "tablet");
  assert.equal(resolveBreakpoint(BREAKPOINTS.laptop), "laptop");
  assert.equal(resolveBreakpoint(BREAKPOINTS.desktop), "desktop");
  assert.equal(resolveBreakpoint(BREAKPOINTS.wide), "wide");
  assert.equal(resolveBreakpoint(BREAKPOINTS.wide + 128), "wide");
});

test("computeTrackListHeight clamps for small and large viewport heights", () => {
  assert.equal(computeTrackListHeight(200), TRACK_LIST_HEIGHT_MIN);
  assert.equal(computeTrackListHeight(2500), TRACK_LIST_HEIGHT_MAX);
  assert.equal(computeTrackListHeight(900), 540);
});

test("track layout helpers produce compact/full modes predictably", () => {
  assert.equal(isCompactTrackLayout(BREAKPOINTS.tablet), true);
  assert.equal(isCompactTrackLayout(BREAKPOINTS.laptop), false);
  assert.equal(resolveTrackHeaderClass(true), "track-header columns-3");
  assert.equal(resolveTrackHeaderClass(false), "track-header columns-6");
});

test("viewport test snapshots can be safely overridden", () => {
  const snapshot = createViewportTestSnapshot({ width: 768, orientation: "portrait" });
  assert.equal(snapshot.width, 768);
  assert.equal(snapshot.orientation, "portrait");
  assert.equal(snapshot.breakpoint, "laptop");
});
