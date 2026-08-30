import { get } from "svelte/store";
import { describe, expect, it } from "vitest";
import type { Bounds } from "./geometry/client";
import { AXIS_STEPS, ViewAxis, createViewerStore } from "./store";

/** Bounds helper: a box from `min` to `max` on every axis unless overridden. */
function box(
  min: [number, number, number],
  max: [number, number, number],
): Bounds {
  return {
    min: { x: min[0], y: min[1], z: min[2] },
    max: { x: max[0], y: max[1], z: max[2] },
  };
}

/** z from -10 to 30: span 40, middle 10. */
const B = box([-5, -5, -10], [5, 5, 30]);

describe("createViewerStore", () => {
  it("starts with no model, no rotation and the Top view", () => {
    const s = createViewerStore();
    const st = s.snapshot();
    expect(st.modelLoaded).toBe(false);
    expect(st.triangleCount).toBe(0);
    expect(st.rotation).toEqual({ x: 0, y: 0, z: 0 });
    expect(st.view).toBe(ViewAxis.Top);
    expect(st.mirror).toBe(false);
    expect(st.filled).toBe(false);
    expect(st.bounds).toBeNull();
    expect(st.busy).toBe(false);
    expect(st.error).toBeNull();
    expect(st.connected).toBe(false);
  });

  it("is a readable store that notifies subscribers", () => {
    const s = createViewerStore();
    const seen: boolean[] = [];
    const stop = s.subscribe((st) => seen.push(st.filled));
    s.setFilled(true);
    stop();
    expect(seen).toEqual([false, true]);
    expect(get(s).filled).toBe(true);
  });

  it("centres the scrubber in the extent when a model loads", () => {
    const s = createViewerStore();
    s.setBusy(true);
    s.setError("stale");
    s.modelLoaded(1234, B);
    const st = s.snapshot();
    expect(st.modelLoaded).toBe(true);
    expect(st.triangleCount).toBe(1234);
    expect(st.bounds).toEqual(B);
    expect(st.axisPos).toBe(10);
    expect(st.busy).toBe(false);
    expect(st.error).toBeNull();
  });

  it("re-centres for the new extent after a view change reports new bounds", () => {
    const s = createViewerStore();
    s.modelLoaded(2, B);
    s.setView(ViewAxis.Front);
    expect(s.snapshot().view).toBe(ViewAxis.Front);
    const front = box([-5, -5, 0], [5, 5, 100]);
    s.boundsChanged(front);
    expect(s.snapshot().bounds).toEqual(front);
    expect(s.snapshot().axisPos).toBe(50);
  });

  it("records rotation per axis", () => {
    const s = createViewerStore();
    s.setRotation("y", 90);
    s.setRotation("z", -45);
    expect(s.snapshot().rotation).toEqual({ x: 0, y: 90, z: -45 });
  });

  it("clamps setAxisPos at both ends of the z range", () => {
    const s = createViewerStore();
    s.modelLoaded(1, B);
    s.setAxisPos(1000);
    expect(s.snapshot().axisPos).toBe(30);
    s.setAxisPos(-1000);
    expect(s.snapshot().axisPos).toBe(-10);
    s.setAxisPos(3.5);
    expect(s.snapshot().axisPos).toBe(3.5);
  });

  it("ignores scrubbing before a model is loaded", () => {
    const s = createViewerStore();
    s.setAxisPos(5);
    s.stepAxis(3);
    expect(s.snapshot().axisPos).toBe(0);
  });

  it("steps by exactly one increment of the extent and clamps", () => {
    const s = createViewerStore();
    s.modelLoaded(1, B);
    const step = 40 / AXIS_STEPS;
    s.stepAxis(1);
    expect(s.snapshot().axisPos).toBeCloseTo(10 + step, 10);
    s.stepAxis(-2);
    expect(s.snapshot().axisPos).toBeCloseTo(10 - step, 10);
    s.stepAxis(10_000);
    expect(s.snapshot().axisPos).toBe(30);
    s.stepAxis(-10_000);
    expect(s.snapshot().axisPos).toBe(-10);
  });

  it("reaches identical state from a hardware key and the equivalent on-screen scrub", () => {
    const hw = createViewerStore();
    const ui = createViewerStore();
    hw.modelLoaded(7, B);
    ui.modelLoaded(7, B);

    hw.handleDeviceKey("PanningRight");
    hw.handleDeviceKey("PanningRight");
    hw.handleDeviceKey("PanningLeft");
    ui.stepAxis(1);
    ui.stepAxis(1);
    ui.stepAxis(-1);

    expect(hw.snapshot()).toEqual(ui.snapshot());
    expect(hw.snapshot().axisPos).toBeCloseTo(10 + 40 / AXIS_STEPS, 10);
  });

  it("survives being detached, as the sink's key listener hands it around", () => {
    const s = createViewerStore();
    s.modelLoaded(1, B);
    const { handleDeviceKey, stepAxis } = s;
    const listener: (k: string) => void = handleDeviceKey;
    listener("PanningRight");
    stepAxis(1);
    expect(s.snapshot().axisPos).toBeCloseTo(10 + (2 * 40) / AXIS_STEPS, 10);
  });

  it("ignores device keys it does not map", () => {
    const s = createViewerStore();
    s.modelLoaded(1, B);
    const before = s.snapshot();
    s.handleDeviceKey("KeyFunction1");
    s.handleDeviceKey("");
    s.handleDeviceKey("PanningUp");
    expect(s.snapshot()).toEqual(before);
  });

  it("labels the axis with the letter for the current view", () => {
    const s = createViewerStore();
    const label = () => get(s.axisLabel);
    expect(label()).toBe("");
    s.modelLoaded(1, B);
    s.setAxisPos(12.44);
    expect(label()).toBe("Z 12.4 mm");
    s.setView(ViewAxis.Front);
    expect(label()).toBe("Y 12.4 mm");
    s.setView(ViewAxis.Side);
    expect(label()).toBe("X 12.4 mm");
  });

  it("records an error without unloading the current model", () => {
    const s = createViewerStore();
    s.modelLoaded(9, B);
    s.setError("not a valid STL");
    const st = s.snapshot();
    expect(st.error).toBe("not a valid STL");
    expect(st.modelLoaded).toBe(true);
    expect(st.triangleCount).toBe(9);
    expect(st.bounds).toEqual(B);
    s.setError(null);
    expect(s.snapshot().error).toBeNull();
  });

  it("tracks busy and connected flags", () => {
    const s = createViewerStore();
    s.setBusy(true);
    expect(s.snapshot().busy).toBe(true);
    s.setConnected(true);
    expect(s.snapshot().connected).toBe(true);
    s.setMirror(true);
    expect(s.snapshot().mirror).toBe(true);
  });
});
