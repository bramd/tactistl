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

/** The letter shown for each view, matching the axis the scrubber walks. */
const AXIS_LETTER: Record<ViewAxisValue, string> = {
  [ViewAxis.Top]: "Z",
  [ViewAxis.Front]: "Y",
  [ViewAxis.Side]: "X",
};

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
  modelLoaded(triangleCount: number, bounds: Bounds): void;
  /** New rotated extent after a rotation or view change; re-centres the scrubber. */
  boundsChanged(bounds: Bounds): void;
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

export function createViewerStore(): ViewerStore {
  const state = writable<ViewerState>(initialState());
  const { subscribe, update } = state;

  /** Scrub relative to the current position; a no-op with no model loaded. */
  function moveAxis(to: (s: ViewerState, span: number) => number): void {
    update((s) => {
      if (!s.bounds) return s;
      const { min, max } = { min: s.bounds.min.z, max: s.bounds.max.z };
      return { ...s, axisPos: clamp(to(s, max - min), min, max) };
    });
  }

  const axisLabel = derived(state, (s) =>
    s.bounds ? `${AXIS_LETTER[s.view]} ${s.axisPos.toFixed(1)} mm` : "",
  );

  return {
    subscribe,
    axisLabel,

    modelLoaded(triangleCount, bounds) {
      update((s) => ({
        ...s,
        modelLoaded: true,
        triangleCount,
        bounds,
        axisPos: middle(bounds),
        busy: false,
        error: null,
      }));
    },

    boundsChanged(bounds) {
      update((s) => ({ ...s, bounds, axisPos: middle(bounds) }));
    },

    setRotation(axis, degrees) {
      update((s) => ({ ...s, rotation: { ...s.rotation, [axis]: degrees } }));
    },

    setView(view) {
      update((s) => ({ ...s, view }));
    },

    setMirror(mirror) {
      update((s) => ({ ...s, mirror }));
    },

    setFilled(filled) {
      update((s) => ({ ...s, filled }));
    },

    setAxisPos(pos) {
      moveAxis(() => pos);
    },

    stepAxis(n) {
      moveAxis((s, span) => s.axisPos + n * (span / AXIS_STEPS));
    },

    handleDeviceKey(keyCode) {
      if (keyCode === "PanningRight") this.stepAxis(1);
      else if (keyCode === "PanningLeft") this.stepAxis(-1);
    },

    setBusy(busy) {
      update((s) => ({ ...s, busy }));
    },

    setError(error) {
      update((s) => ({ ...s, error }));
    },

    setConnected(connected) {
      update((s) => ({ ...s, connected }));
    },

    snapshot() {
      return get(state);
    },
  };
}
