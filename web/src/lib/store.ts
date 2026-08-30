/**
 * The single source of truth for the viewer.
 *
 * Several independent sources drive the same re-slice / re-rasterize / render
 * pipeline: the rotation inputs, the view selector, the on-screen scrubber and
 * the Dot Pad's own hardware keys. If each wired itself to the pipeline
 * directly they would drift apart -- a hardware key that forgets to move the
 * slider leaves the display and the UI disagreeing. So every source writes
 * only here, and one subscription runs the pipeline.
 *
 * State only: this module imports no geometry client, no sink and nothing from
 * the UI, which is what lets the invariants below be plain unit tests.
 */
import { derived, get, writable, type Readable } from "svelte/store";
import type { Bounds } from "./geometry/client";

/**
 * Which model axis the slice plane sweeps. The numbers are the wire format and
 * must match `ViewAxis::from_u8` on the Rust side.
 */
export const ViewAxis = { Top: 0, Front: 1, Side: 2 } as const;

export type ViewAxisValue = (typeof ViewAxis)[keyof typeof ViewAxis];

/** Scrubber resolution: the number of increments across the whole extent. */
export const AXIS_STEPS = 100;

export interface ViewerState {
  modelLoaded: boolean;
  triangleCount: number;
  rotation: { x: number; y: number; z: number };
  view: ViewAxisValue;
  mirror: boolean;
  filled: boolean;
  /**
   * The slice plane's position along world Z *in the rotated frame*. Slicing
   * is always along world Z; the view preset rotates the model so the wanted
   * axis lands there, so this is not a model coordinate.
   */
  axisPos: number;
  /** The rotated extent: `z` is the scrubber's range, `x`/`y` frame the raster. */
  bounds: Bounds | null;
  busy: boolean;
  error: string | null;
  connected: boolean;
}

function initialState(): ViewerState {
  return {
    modelLoaded: false,
    triangleCount: 0,
    rotation: { x: 0, y: 0, z: 0 },
    view: ViewAxis.Top,
    mirror: false,
    filled: false,
    axisPos: 0,
    bounds: null,
    busy: false,
    error: null,
    connected: false,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const middle = (b: Bounds) => (b.min.z + b.max.z) / 2;

export interface ViewerStore extends Readable<ViewerState> {
  /** A model finished parsing: centre the scrubber and clear any stale error. */
  onModelLoaded(triangleCount: number, bounds: Bounds): void;
  /**
   * A new rotated extent for the SAME sweep axis, after a rotation change.
   *
   * Keeps the same fraction through the extent rather than re-centring. A user
   * nudging the rotation a degree to compare is reading one cross-section; a
   * silent jump back to the middle loses their place, and the only feedback is
   * the display changing under their fingers, which reads as the rotation
   * having done something drastic. A degree changes the extent by a fraction
   * of a percent, so the same fraction is very nearly the same plane.
   */
  boundsChanged(bounds: Bounds): void;
  /**
   * A new rotated extent for a DIFFERENT sweep axis, after a view change.
   *
   * Re-centres, because carrying a fraction across is meaningless here: Top to
   * Front swaps the sweep from the model's Z to its Y, an unrelated extent.
   */
  viewChanged(bounds: Bounds): void;
  setRotation(axis: "x" | "y" | "z", degrees: number): void;
  setView(view: ViewAxisValue): void;
  setMirror(mirror: boolean): void;
  setFilled(filled: boolean): void;
  /** Move the slice plane, clamped to the rotated extent's z range. */
  setAxisPos(pos: number): void;
  /** Move by `n` scrubber increments of `span / AXIS_STEPS`, clamped. */
  stepAxis(n: number): void;
  /** Map a Dot Pad key to a scrub. Unmapped keys are ignored. */
  handleDeviceKey(keyCode: string): void;
  setBusy(busy: boolean): void;
  /** Record a failure. Never unloads the model: a bad new file leaves the old one usable. */
  setError(error: string | null): void;
  setConnected(connected: boolean): void;
  snapshot(): ViewerState;
  /** e.g. `"Z 12.4 mm"`; empty until there are bounds. */
  axisLabel: Readable<string>;
}

/**
 * Every method is a closure bound at construction, never a `this`-dependent
 * object method. They are handed to SDK callbacks and Svelte event handlers,
 * which call them detached; one that relied on `this` would throw at whatever
 * call site first passed it along, which for a hardware key looks like the
 * button silently doing nothing.
 */
export function createViewerStore(): ViewerStore {
  const state = writable<ViewerState>(initialState());
  const { subscribe, update } = state;

  /** Scrub relative to the current position; a no-op with no model loaded. */
  const moveAxis = (to: (s: ViewerState, span: number) => number): void => {
    update((s) => {
      if (!s.bounds) return s;
      const min = s.bounds.min.z;
      const max = s.bounds.max.z;
      return { ...s, axisPos: clamp(to(s, max - min), min, max) };
    });
  };

  const onModelLoaded = (triangleCount: number, bounds: Bounds): void => {
    update((s) => ({
      ...s,
      modelLoaded: true,
      triangleCount,
      bounds,
      axisPos: middle(bounds),
      busy: false,
      error: null,
    }));
  };

  const boundsChanged = (bounds: Bounds): void => {
    update((s) => {
      const oldSpan = s.bounds ? s.bounds.max.z - s.bounds.min.z : 0;
      // A flat extent has no fraction to preserve, and dividing by its span
      // would put NaN on the scrubber, which every later clamp would carry.
      const fraction =
        s.bounds && oldSpan > 0 ? (s.axisPos - s.bounds.min.z) / oldSpan : 0.5;
      const pos = bounds.min.z + fraction * (bounds.max.z - bounds.min.z);
      return { ...s, bounds, axisPos: clamp(pos, bounds.min.z, bounds.max.z) };
    });
  };

  const viewChanged = (bounds: Bounds): void => {
    update((s) => ({ ...s, bounds, axisPos: middle(bounds) }));
  };

  const setRotation = (axis: "x" | "y" | "z", degrees: number): void => {
    update((s) => ({ ...s, rotation: { ...s.rotation, [axis]: degrees } }));
  };

  const setView = (view: ViewAxisValue): void => {
    update((s) => ({ ...s, view }));
  };

  const setMirror = (mirror: boolean): void => {
    update((s) => ({ ...s, mirror }));
  };

  const setFilled = (filled: boolean): void => {
    update((s) => ({ ...s, filled }));
  };

  const setAxisPos = (pos: number): void => {
    moveAxis(() => pos);
  };

  const stepAxis = (n: number): void => {
    moveAxis((s, span) => s.axisPos + n * (span / AXIS_STEPS));
  };

  const handleDeviceKey = (keyCode: string): void => {
    if (keyCode === "PanningRight") stepAxis(1);
    else if (keyCode === "PanningLeft") stepAxis(-1);
  };

  const setBusy = (busy: boolean): void => {
    update((s) => ({ ...s, busy }));
  };

  const setError = (error: string | null): void => {
    update((s) => ({ ...s, error }));
  };

  const setConnected = (connected: boolean): void => {
    update((s) => ({ ...s, connected }));
  };

  const snapshot = (): ViewerState => get(state);

  /**
   * Position within the sweep -- distance from its start, and its full span --
   * rather than a coordinate.
   *
   * There is deliberately no axis letter. A letter would name the VIEW's sweep
   * axis, not the model's: after any user rotation it corresponds to nothing
   * the user could cross-check in a slicer, and Front and Side are
   * sign-flipping besides, so the number counted DOWN as the model's Y or X
   * counted up. A plausible-looking coordinate that quietly lies is the worst
   * thing to hand someone whose whole purpose here is confirming orientation.
   * A position within the sweep is true under every rotation and view, and
   * carrying the span keeps the sense of scale a bare percentage would lose.
   */
  const axisLabel = derived(state, (s) => {
    if (!s.bounds) return "";
    const from = s.axisPos - s.bounds.min.z;
    const span = s.bounds.max.z - s.bounds.min.z;
    return `${from.toFixed(1)} of ${span.toFixed(1)} mm`;
  });

  return {
    subscribe,
    axisLabel,
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
  };
}
