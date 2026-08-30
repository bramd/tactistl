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
    s.onModelLoaded(1234, B);
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
    s.onModelLoaded(2, B);
    s.setAxisPos(25);
    s.setView(ViewAxis.Front);
    expect(s.snapshot().view).toBe(ViewAxis.Front);
    // Front sweeps the model's Y: an unrelated extent, so 87% through the old
    // one means nothing. The middle is the only honest default.
    const front = box([-5, -5, 0], [5, 5, 100]);
    s.viewChanged(front);
    expect(s.snapshot().bounds).toEqual(front);
    expect(s.snapshot().axisPos).toBe(50);
  });

  it("keeps the reading position when a rotation nudge changes the extent", () => {
    const s = createViewerStore();
    s.onModelLoaded(1, B);
    s.setAxisPos(20); // 75% through a span of 40
    s.setRotation("x", 1);
    s.boundsChanged(box([-6, -6, -10], [6, 6, 34])); // span 44
    expect(s.snapshot().axisPos).toBeCloseTo(-10 + 0.75 * 44, 10);
  });

  it("preserves the fraction through an extent that shrinks", () => {
    const s = createViewerStore();
    s.onModelLoaded(1, B);
    s.setAxisPos(0); // 25% through a span of 40
    s.boundsChanged(box([-5, -5, 0], [5, 5, 20])); // span 20
    expect(s.snapshot().axisPos).toBeCloseTo(5, 10);
  });

  it("centres rather than dividing by zero when an extent is flat", () => {
    const s = createViewerStore();
    s.onModelLoaded(1, box([-5, -5, 7], [5, 5, 7])); // a flat plate seen edge-on
    expect(s.snapshot().axisPos).toBe(7);
    s.boundsChanged(box([-5, -5, 0], [5, 5, 40]));
    const pos = s.snapshot().axisPos;
    expect(Number.isNaN(pos)).toBe(false);
    expect(pos).toBe(20);
    s.boundsChanged(box([-5, -5, 3], [5, 5, 3]));
    expect(s.snapshot().axisPos).toBe(3);
  });

  it("records rotation per axis", () => {
    const s = createViewerStore();
    s.setRotation("y", 90);
    s.setRotation("z", -45);
    expect(s.snapshot().rotation).toEqual({ x: 0, y: 90, z: -45 });
  });

  it("clamps setAxisPos at both ends of the z range", () => {
    const s = createViewerStore();
    s.onModelLoaded(1, B);
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
    s.onModelLoaded(1, B);
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
    hw.onModelLoaded(7, B);
    ui.onModelLoaded(7, B);

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
    s.onModelLoaded(1, B);
    const { handleDeviceKey, stepAxis } = s;
    const listener: (k: string) => void = handleDeviceKey;
    listener("PanningRight");
    stepAxis(1);
    expect(s.snapshot().axisPos).toBeCloseTo(10 + (2 * 40) / AXIS_STEPS, 10);
  });

  it("survives every method being detached from the store", () => {
    // These are handed to SDK callbacks and Svelte event handlers, which call
    // them bare. A future method that closes over `this` fails here rather
    // than at whatever call site first passes it along.
    const s = createViewerStore();
    const {
      onModelLoaded,
      boundsChanged,
      viewChanged,
      setRotation,
      setView,
      setMirror,
      setFilled,
      setAxisPos,
      stepAxis,
      handleDeviceKey,
      setBusy,
      setError,
      setConnected,
      snapshot,
    } = s;
    expect(() => {
      onModelLoaded(3, B);
      boundsChanged(B);
      viewChanged(B);
      setRotation("x", 5);
      setView(ViewAxis.Side);
      setMirror(true);
      setFilled(true);
      setAxisPos(4);
      stepAxis(1);
      handleDeviceKey("PanningLeft");
      setBusy(true);
      setError("e");
      setConnected(true);
    }).not.toThrow();
    expect(snapshot().triangleCount).toBe(3);
    expect(snapshot().axisPos).toBe(4);
  });

  it("ignores device keys it does not map", () => {
    const s = createViewerStore();
    s.onModelLoaded(1, B);
    const before = s.snapshot();
    s.handleDeviceKey("KeyFunction1");
    s.handleDeviceKey("");
    s.handleDeviceKey("PanningUp");
    expect(s.snapshot()).toEqual(before);
  });

  it("labels the position within the sweep, not a coordinate", () => {
    const s = createViewerStore();
    const label = () => get(s.axisLabel);
    expect(label()).toBe("");
    s.onModelLoaded(1, B); // z from -10 to 30: a span of 40
    s.setAxisPos(2.44);
    expect(label()).toBe("12.4 of 40.0 mm");
  });

  it("reads 0.0 at the start of the sweep and the full span at the end", () => {
    const s = createViewerStore();
    const label = () => get(s.axisLabel);
    s.onModelLoaded(1, B);
    s.setAxisPos(-10);
    expect(label()).toBe("0.0 of 40.0 mm");
    s.setAxisPos(30);
    expect(label()).toBe("40.0 of 40.0 mm");
  });

  it("does not change when only the view changes", () => {
    // It carried a view-dependent axis letter once. The letter named the
    // view's sweep axis rather than the model's, so it stopped being true
    // under any user rotation.
    const s = createViewerStore();
    s.onModelLoaded(1, B);
    s.setAxisPos(5);
    const before = get(s.axisLabel);
    s.setView(ViewAxis.Front);
    expect(get(s.axisLabel)).toBe(before);
    s.setView(ViewAxis.Side);
    expect(get(s.axisLabel)).toBe(before);
  });

  it("labels a flat extent without producing NaN", () => {
    const s = createViewerStore();
    s.onModelLoaded(1, box([-5, -5, 7], [5, 5, 7]));
    expect(get(s.axisLabel)).toBe("0.0 of 0.0 mm");
  });

  it("records an error without unloading the current model", () => {
    const s = createViewerStore();
    s.onModelLoaded(9, B);
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
