/**
 * The one place that reads the store and drives output.
 *
 * Every input source -- the rotation fields, the view selector, the scrubber,
 * the Dot Pad's own hardware keys -- writes only to the store. This subscribes
 * once and runs slice -> rasterize -> output. Wiring each source to the
 * pipeline separately is exactly how a hardware key ends up moving the display
 * without moving the on-screen slider, so there is deliberately no second path
 * from an input to a sink.
 */
import type { Bitmap, TactileSink } from "./tactile/types";
import type { RenderRequest } from "./geometry/client";
import type { ViewerState, ViewerStore } from "./store";
import { LatestWinsQueue } from "./util/latest-wins";

/** The part of `GeometryClient` the pipeline uses; narrowed so tests can fake it. */
export interface GeometryLike {
  render(req: RenderRequest): Promise<Bitmap>;
}

/**
 * Used when there are no sinks at all. Matches the Dot Pad A320, so a headless
 * pipeline rasterizes at the size the device most users attach would want.
 */
const FALLBACK_GRID = { width: 60, height: 40 } as const;

/**
 * Identifies a render. Two states with the same key produce byte-identical
 * output, so the second is not worth a slice.
 *
 * This is not only an optimisation. The state subscription fires on EVERY
 * store change, `error` included -- and a render failure calls `setError`. So
 * without a relevance check, one failing render resubmits itself forever:
 * render rejects, setError writes, the subscription fires, the same doomed
 * request goes in again. The check is what makes a persistent WASM failure
 * settle into one error instead of a spin.
 */
function renderKey(req: RenderRequest): string {
  return [
    ...req.rotation,
    req.view,
    req.z,
    req.width,
    req.height,
    req.filled ? 1 : 0,
    req.mirror ? 1 : 0,
  ].join("|");
}

function requestFor(s: ViewerState, grid: { width: number; height: number }): RenderRequest {
  return {
    rotation: [s.rotation.x, s.rotation.y, s.rotation.z],
    view: s.view,
    z: s.axisPos,
    width: grid.width,
    height: grid.height,
    filled: s.filled,
    mirror: s.mirror,
  };
}

/**
 * Subscribe the geometry worker and the sinks to the store.
 *
 * @returns a cleanup function that unsubscribes everything. A render already in
 * flight when it is called still reaches the sinks; there is nothing to cancel
 * a WASM call with, and one stale frame at teardown is not worth pretending
 * otherwise.
 */
export function startPipeline(
  store: ViewerStore,
  geometry: GeometryLike,
  sinks: TactileSink[],
): () => void {
  /**
   * Coalesces renders. This is the same reasoning as the sink's own frame
   * queue, one layer up, and both are needed: the render is expensive and the
   * device write is slow, and they are independent bottlenecks. Dragging the
   * scrubber must not queue one WASM slice per pixel of travel.
   */
  const queue = new LatestWinsQueue<RenderRequest>(
    async (req) => {
      const bitmap = await geometry.render(req);
      for (const sink of sinks) sink.renderFrame(bitmap);
    },
    (e) => {
      // Surfaced rather than swallowed: the user is blind and cannot see that
      // the display has gone stale, so a silent drop is indistinguishable from
      // geometry that genuinely did not change.
      store.setError(e instanceof Error ? e.message : String(e));
    },
  );

  let lastKey: string | null = null;

  const stopState = store.subscribe((s) => {
    if (!s.modelLoaded || !s.bounds) return;
    // Read the grid per submission, never snapshotted at startup: a sink's grid
    // changes when a device connects and reports its own cell counts, and the
    // `connected` flip is what brings us back here to notice.
    const grid = sinks[0]?.grid ?? FALLBACK_GRID;
    const req = requestFor(s, grid);
    const key = renderKey(req);
    if (key === lastKey) return;
    lastKey = key;
    queue.submit(req);
  });

  // Svelte already suppresses an unchanged primitive, but the guard is stated
  // here rather than relied on: the label goes to a braille text line, and a
  // repeat of it under the user's fingers reads as something having changed.
  let lastLabel: string | null = null;
  const stopLabel = store.axisLabel.subscribe((label) => {
    if (label === lastLabel) return;
    lastLabel = label;
    // The empty label means there are no bounds yet -- nothing to announce.
    if (label === "") return;
    for (const sink of sinks) sink.renderText(label);
  });

  return () => {
    stopState();
    stopLabel();
  };
}
