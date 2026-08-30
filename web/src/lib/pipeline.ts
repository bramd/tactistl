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
import { get } from "svelte/store";
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
  // Declared before the state subscription: the connect transition below pushes
  // the current label directly, so both writers have to see the same variable.
  let lastLabel: string | null = null;
  let lastConnected = false;
  let stopped = false;

  /**
   * The one place that writes the text line, so the "do not repeat a line the
   * fingers are already resting on" guard cannot be half-applied.
   */
  const sendLabel = (label: string): void => {
    if (label === lastLabel) return;
    lastLabel = label;
    // The empty label means there are no bounds yet -- nothing to announce.
    if (label === "") return;
    for (const sink of sinks) sink.renderText(label);
  };

  /**
   * A whole synchronous burst of store writes collapses into one render.
   *
   * A store write notifies subscribers immediately and one at a time, so two
   * writes that only make sense together -- the view and the bounds that view
   * was measured under -- are observed here as an intermediate state that never
   * existed as far as the user is concerned. Rendering it costs a real frame on
   * hardware: roughly a second of pin actuation showing a cross-section taken
   * at a plane outside the new extent, i.e. a blank plate, before the correct
   * frame arrives. Deferring by a microtask means the caller's writes have all
   * landed before anything is rasterized.
   */
  let latest: ViewerState | null = null;
  let flushQueued = false;

  const flush = (): void => {
    flushQueued = false;
    const s = latest;
    latest = null;
    if (stopped || !s) return;

    // A connect (or a drop) has to invalidate BOTH caches. The grid a real
    // A320 reports is byte-identical to the fallback rasterized against while
    // disconnected, so the render key does not change on its own and nothing
    // would ever be sent; and the label was already emitted to a sink that was
    // dropping writes on the floor, so it has to be re-issued too.
    const connectionChanged = s.connected !== lastConnected;
    if (connectionChanged) {
      lastConnected = s.connected;
      lastKey = null;
      lastLabel = null;
    }

    if (!s.modelLoaded || !s.bounds) return;

    // Pushed rather than left to the label subscription: that store is derived,
    // and a derived store suppresses a value equal to the one it already holds.
    // Clearing `lastLabel` alone would therefore do nothing until the position
    // next moved, which is the user having to touch a control to get the line
    // they just connected for.
    if (connectionChanged) sendLabel(get(store.axisLabel));

    // Read the grid per submission, never snapshotted at startup: a sink's grid
    // changes when a device connects and reports its own cell counts, and the
    // `connected` flip is what brings us back here to notice.
    const grid = sinks[0]?.grid ?? FALLBACK_GRID;
    const req = requestFor(s, grid);
    const key = renderKey(req);
    if (key === lastKey) return;
    lastKey = key;
    queue.submit(req);
  };

  const stopState = store.subscribe((s) => {
    latest = s;
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(flush);
  });

  // Svelte already suppresses an unchanged primitive, but the guard is stated
  // in `sendLabel` rather than relied on: the label goes to a braille text
  // line, and a repeat of it under the user's fingers reads as something having
  // changed.
  const stopLabel = store.axisLabel.subscribe(sendLabel);

  return () => {
    stopped = true;
    stopState();
    stopLabel();
  };
}
