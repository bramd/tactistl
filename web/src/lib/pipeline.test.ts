import { describe, expect, it } from "vitest";
import type { Bounds, RenderRequest } from "./geometry/client";
import { NO_MODEL_MESSAGE, startPipeline } from "./pipeline";
import { SimpleBrailleRenderer } from "./dotpad/braille";
import { CanvasPreviewSink } from "./tactile/preview";
import { ViewAxis, createViewerStore } from "./store";
import type { Bitmap, TactileSink, Transport } from "./tactile/types";

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

/** Lets the microtask queue drain so queued renders and their sends settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * A geometry client whose renders settle only when the test says so, which is
 * what makes coalescing observable: while one render is deliberately held in
 * flight, every state change behind it must collapse to a single follow-up.
 */
function fakeGeometry() {
  const requests: RenderRequest[] = [];
  let settle: (() => void) | null = null;
  let fail: string | null = null;
  const bitmapFor = (req: RenderRequest): Bitmap => ({
    width: req.width,
    height: req.height,
    data: new Uint8Array(req.width * req.height),
  });
  return {
    requests,
    /** Reject every render from now on, with this message. */
    failWith(message: string) {
      fail = message;
    },
    /** Settle the render currently in flight. */
    release() {
      const s = settle;
      settle = null;
      s?.();
    },
    client: {
      render(req: RenderRequest): Promise<Bitmap> {
        requests.push(req);
        if (fail !== null) return Promise.reject(new Error(fail));
        return new Promise<Bitmap>((resolve) => {
          settle = () => resolve(bitmapFor(req));
        });
      },
    },
  };
}

class FakeSink implements TactileSink {
  readonly frames: Bitmap[] = [];
  readonly texts: string[] = [];
  /** How many times the pipeline asked for the display to be blanked. */
  clears = 0;
  grid: { width: number; height: number };

  constructor(width = 60, height = 40) {
    this.grid = { width, height };
  }

  get availableTransports(): Transport[] {
    return [];
  }
  renderFrame(bitmap: Bitmap): void {
    this.frames.push(bitmap);
  }
  renderText(text: string): void {
    this.texts.push(text);
  }
  clear(): void {
    this.clears++;
  }
  async connect(_transport: Transport): Promise<void> {}
  async disconnect(): Promise<void> {}
}

describe("startPipeline", () => {
  it("renders on a state change and delivers the bitmap to every sink", async () => {
    const store = createViewerStore();
    const g = fakeGeometry();
    const a = new FakeSink();
    const b = new FakeSink();
    const stop = startPipeline(store, g.client, [a, b]);

    store.onModelLoaded(12, B);
    await flush();
    g.release();
    await flush();

    expect(g.requests).toHaveLength(1);
    expect(a.frames).toHaveLength(1);
    expect(b.frames).toHaveLength(1);
    expect(b.frames[0]).toBe(a.frames[0]);
    stop();
  });

  it("does not render while no model is loaded", async () => {
    const store = createViewerStore();
    const g = fakeGeometry();
    const sink = new FakeSink();
    const stop = startPipeline(store, g.client, [sink]);

    store.setBusy(true);
    store.setConnected(true);
    await flush();

    expect(g.requests).toEqual([]);
    expect(sink.frames).toEqual([]);
    stop();
  });

  it("coalesces a burst of scrubbing into one follow-up render of the last state", async () => {
    const store = createViewerStore();
    const g = fakeGeometry();
    const sink = new FakeSink();
    const stop = startPipeline(store, g.client, [sink]);

    store.onModelLoaded(12, B);
    await flush();
    expect(g.requests).toHaveLength(1);

    // 40 scrubber positions while the first render is still in flight.
    for (let i = 1; i <= 40; i++) store.setAxisPos(i);
    await flush();
    expect(g.requests).toHaveLength(1);

    g.release();
    await flush();
    g.release();
    await flush();

    expect(g.requests).toHaveLength(2);
    expect(g.requests[1].z).toBe(30); // clamped to max, the last position
    stop();
  });

  it("carries the store's rotation, view, z, filled and mirror", async () => {
    const store = createViewerStore();
    const g = fakeGeometry();
    const stop = startPipeline(store, g.client, [new FakeSink()]);

    store.onModelLoaded(12, B);
    await flush();
    g.release();
    await flush();

    store.setRotation("x", 15);
    store.setRotation("y", -30);
    store.setRotation("z", 90);
    store.setView(ViewAxis.Side);
    store.setMirror(true);
    store.setFilled(true);
    store.setAxisPos(7);
    await flush();
    g.release();
    await flush();
    g.release();
    await flush();

    const last = g.requests[g.requests.length - 1];
    expect(last.rotation).toEqual([15, -30, 90]);
    expect(last.view).toBe(ViewAxis.Side);
    expect(last.z).toBe(7);
    expect(last.mirror).toBe(true);
    expect(last.filled).toBe(true);
    stop();
  });

  it("renders at the first sink's grid", async () => {
    const store = createViewerStore();
    const g = fakeGeometry();
    const stop = startPipeline(store, g.client, [
      new FakeSink(30, 20),
      new FakeSink(60, 40),
    ]);

    store.onModelLoaded(12, B);
    await flush();
    g.release();
    await flush();

    expect(g.requests[0].width).toBe(30);
    expect(g.requests[0].height).toBe(20);
    stop();
  });

  it("falls back to 60x40 with no sinks at all", async () => {
    const store = createViewerStore();
    const g = fakeGeometry();
    const stop = startPipeline(store, g.client, []);

    store.onModelLoaded(12, B);
    await flush();
    g.release();
    await flush();

    expect(g.requests[0].width).toBe(60);
    expect(g.requests[0].height).toBe(40);
    stop();
  });

  it("picks up a sink's grid changing after a connect", async () => {
    const store = createViewerStore();
    const g = fakeGeometry();
    const sink = new FakeSink();
    const stop = startPipeline(store, g.client, [sink]);

    store.onModelLoaded(12, B);
    await flush();
    g.release();
    await flush();

    sink.grid = { width: 40, height: 20 };
    store.setConnected(true);
    await flush();
    g.release();
    await flush();

    expect(g.requests).toHaveLength(2);
    expect(g.requests[1].width).toBe(40);
    expect(g.requests[1].height).toBe(20);
    stop();
  });

  it("sends a frame and re-sends the text line when a connect leaves the grid unchanged", async () => {
    const store = createViewerStore();
    const g = fakeGeometry();
    // 60x40 -- byte-identical to the disconnected fallback, which is exactly
    // what a real Dot Pad A320 reports. Nothing about the render request
    // changes on connect, so only the connect transition itself can force the
    // first frame the device ever receives.
    const sink = new FakeSink(60, 40);
    const stop = startPipeline(store, g.client, [sink]);

    store.onModelLoaded(12, B);
    await flush();
    g.release();
    await flush();
    expect(g.requests).toHaveLength(1);
    expect(sink.texts).toEqual(["20.0 of 40.0 mm"]);

    store.setConnected(true);
    await flush();
    g.release();
    await flush();

    // The frame: everything before the connect went nowhere, because the sink
    // was dropping writes while disconnected.
    expect(g.requests).toHaveLength(2);
    expect(g.requests[1]).toEqual(g.requests[0]);
    expect(sink.frames).toHaveLength(2);
    // And the text line, which is a separate cache and breaks on every device.
    expect(sink.texts).toEqual(["20.0 of 40.0 mm", "20.0 of 40.0 mm"]);
    stop();
  });

  it("renders once for a view and its bounds written back to back", async () => {
    const store = createViewerStore();
    const g = fakeGeometry();
    const sink = new FakeSink();
    const stop = startPipeline(store, g.client, [sink]);

    store.onModelLoaded(12, B);
    await flush();
    g.release();
    await flush();
    expect(g.requests).toHaveLength(1);

    // What `App.svelte`'s `onView` does once the new view's bounds are in
    // hand. The intermediate state -- new view, old sweep's position -- must
    // never reach the device: on hardware it is a second of pin actuation
    // showing a plane outside the new extent, i.e. a blank plate.
    store.setView(ViewAxis.Front);
    store.viewChanged(box([-5, -5, 0], [5, 5, 100]));
    await flush();
    g.release();
    await flush();

    expect(g.requests).toHaveLength(2);
    expect(g.requests[1].view).toBe(ViewAxis.Front);
    expect(g.requests[1].z).toBe(50);
    expect(sink.frames).toHaveLength(2);
    stop();
  });

  it("reports a render failure through setError", async () => {
    const store = createViewerStore();
    const g = fakeGeometry();
    const stop = startPipeline(store, g.client, [new FakeSink()]);

    g.failWith("the mesh has no triangles at that plane");
    store.onModelLoaded(12, B);
    await flush();

    expect(store.snapshot().error).toBe(
      "the mesh has no triangles at that plane",
    );
    stop();
  });

  it("does not re-render in a loop when setError feeds the failure back in", async () => {
    const store = createViewerStore();
    const g = fakeGeometry();
    const stop = startPipeline(store, g.client, [new FakeSink()]);

    g.failWith("boom");
    store.onModelLoaded(12, B);
    await flush();
    await flush();

    // setError is itself a state change; without a render-relevance check it
    // would resubmit the same doomed request forever.
    expect(g.requests).toHaveLength(1);
    stop();
  });

  it("skips state changes that cannot alter the raster", async () => {
    const store = createViewerStore();
    const g = fakeGeometry();
    const stop = startPipeline(store, g.client, [new FakeSink()]);

    store.onModelLoaded(12, B);
    await flush();
    g.release();
    await flush();
    expect(g.requests).toHaveLength(1);

    store.setBusy(true);
    store.setBusy(false);
    store.setError("something else went wrong");
    await flush();

    expect(g.requests).toHaveLength(1);
    stop();
  });

  it("sends the axis label to every sink when it changes, and not otherwise", async () => {
    const store = createViewerStore();
    const g = fakeGeometry();
    const a = new FakeSink();
    const b = new FakeSink();
    const stop = startPipeline(store, g.client, [a, b]);

    // No bounds yet: the label is empty and nothing is worth announcing.
    expect(a.texts).toEqual([]);

    store.onModelLoaded(12, B);
    expect(a.texts).toEqual(["20.0 of 40.0 mm"]);
    expect(b.texts).toEqual(["20.0 of 40.0 mm"]);

    // A change that leaves the label alone must not repeat it.
    store.setFilled(true);
    store.setBusy(true);
    expect(a.texts).toEqual(["20.0 of 40.0 mm"]);

    store.setAxisPos(0);
    expect(a.texts).toEqual(["20.0 of 40.0 mm", "10.0 of 40.0 mm"]);
    expect(b.texts).toEqual(["20.0 of 40.0 mm", "10.0 of 40.0 mm"]);
    stop();
  });

  it("stops rendering and labelling after cleanup", async () => {
    const store = createViewerStore();
    const g = fakeGeometry();
    const sink = new FakeSink();
    const stop = startPipeline(store, g.client, [sink]);

    store.onModelLoaded(12, B);
    await flush();
    g.release();
    await flush();
    const renders = g.requests.length;
    const texts = sink.texts.length;

    stop();
    store.setAxisPos(0);
    store.setView(ViewAxis.Front);
    await flush();

    expect(g.requests).toHaveLength(renders);
    expect(sink.texts).toHaveLength(texts);
  });
});

describe("connecting with no model loaded", () => {
  it("blanks the sinks and says so on the text line", async () => {
    const store = createViewerStore();
    const g = fakeGeometry();
    const sink = new FakeSink();
    const stop = startPipeline(store, g.client, [sink]);

    store.setConnected(true);
    await flush();

    // A tactile display holds its dots mechanically, so before this it kept
    // whatever was physically on it -- a previous session's frame, or another
    // app's output -- with nothing to say so.
    expect(sink.clears).toBe(1);
    // And blanking alone is not enough: lowered pins are exactly what a
    // connection that silently failed feels like, so the line is the positive
    // confirmation that the link is open and there is nothing loaded.
    expect(sink.texts).toEqual([NO_MODEL_MESSAGE]);
    expect(g.requests).toHaveLength(0);
    stop();
  });

  it("blanks every sink, not just the device", async () => {
    const store = createViewerStore();
    const g = fakeGeometry();
    const a = new FakeSink();
    const b = new FakeSink();
    const stop = startPipeline(store, g.client, [a, b]);

    store.setConnected(true);
    await flush();

    // The on-screen preview has to agree with the device, or a sighted
    // collaborator is looking at a frame the reader's fingers cannot find.
    expect(a.clears).toBe(1);
    expect(b.clears).toBe(1);
    stop();
  });

  it("does not blank anything when the device drops", async () => {
    const store = createViewerStore();
    const g = fakeGeometry();
    const sink = new FakeSink();
    const stop = startPipeline(store, g.client, [sink]);

    store.setConnected(true);
    await flush();
    store.setConnected(false);
    await flush();

    // The disconnect transition runs the same block. There is no device left
    // to write to, and clearing on the way out would be a write into nowhere.
    expect(sink.clears).toBe(1);
    stop();
  });

  it("shows the real label once a model arrives, and blanks nothing more", async () => {
    const store = createViewerStore();
    const g = fakeGeometry();
    const sink = new FakeSink();
    const stop = startPipeline(store, g.client, [sink]);

    store.setConnected(true);
    await flush();
    store.onModelLoaded(12, B);
    await flush();
    g.release();
    await flush();

    // The message must not become a duplicate-suppressing cache entry that
    // eats the first real position line.
    expect(sink.texts).toEqual([NO_MODEL_MESSAGE, "20.0 of 40.0 mm"]);
    expect(sink.clears).toBe(1);
    expect(sink.frames).toHaveLength(1);
    stop();
  });

  it("says it again on a reconnect that is still empty", async () => {
    const store = createViewerStore();
    const g = fakeGeometry();
    const sink = new FakeSink();
    const stop = startPipeline(store, g.client, [sink]);

    store.setConnected(true);
    await flush();
    store.setConnected(false);
    await flush();
    store.setConnected(true);
    await flush();

    // The second device has its own pins, holding their own stale state.
    expect(sink.clears).toBe(2);
    expect(sink.texts).toEqual([NO_MODEL_MESSAGE, NO_MODEL_MESSAGE]);
    stop();
  });
});

describe("connecting with a model loaded", () => {
  it("does not blank, and still forces the frame and the label", async () => {
    const store = createViewerStore();
    const g = fakeGeometry();
    // 60x40, byte-identical to the disconnected fallback, so only the connect
    // transition itself can force this frame -- the case the clear must not
    // disturb.
    const sink = new FakeSink(60, 40);
    const stop = startPipeline(store, g.client, [sink]);

    store.onModelLoaded(12, B);
    await flush();
    g.release();
    await flush();

    store.setConnected(true);
    await flush();
    g.release();
    await flush();

    // Blanking here would flash, and would restart the SDK's multi-second pin
    // re-actuation cycle for a frame that is about to land anyway.
    expect(sink.clears).toBe(0);
    expect(g.requests).toHaveLength(2);
    expect(sink.frames).toHaveLength(2);
    expect(sink.texts).toEqual(["20.0 of 40.0 mm", "20.0 of 40.0 mm"]);
    stop();
  });
});

describe("NO_MODEL_MESSAGE", () => {
  it("fits the A320's 20-cell braille line with room to spare", async () => {
    // Measured through the renderer the device actually gets, not counted by
    // hand: the renderer spends extra cells on number and capital indicators,
    // so character count is not cell count in general.
    const hex = await new SimpleBrailleRenderer().toCellHex(NO_MODEL_MESSAGE, 20);
    const cells = hex.match(/../g) ?? [];
    expect(cells).toHaveLength(20);

    // Trailing blanks are padding; what matters is that the message ends
    // before the line does, so nothing is truncated mid-word.
    const used = cells.length - [...cells].reverse().findIndex((c) => c !== "00");
    expect(used).toBe(15);
    expect(used).toBeLessThan(20);

    // Everything the renderer cannot render becomes a blank cell, so a stray
    // character would silently punch a hole in the middle of the message.
    const interior = cells.slice(0, used);
    const blanks = interior.filter((c) => c === "00").length;
    expect(blanks).toBe(NO_MODEL_MESSAGE.split(" ").length - 1);
  });
});

/**
 * The preview draws into a 2d context, and the test environment has no DOM, so
 * this stands in for both. Only the calls `paint` makes are recorded: what
 * matters is which dots came out bright.
 */
function fakeCanvas() {
  const fills: string[] = [];
  const ctx = {
    fillStyle: "",
    fillRect: () => {},
    beginPath: () => {},
    arc: () => {},
    fill() {
      fills.push(ctx.fillStyle);
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
  };
  return {
    fills,
    /** How many dots the last paint drew raised. */
    raised: () => fills.filter((c) => c === "#f2f2f7").length,
    /** Discard everything painted so far, so the next paint stands alone. */
    reset: () => fills.splice(0, fills.length),
    element: canvas as unknown as HTMLCanvasElement,
  };
}

/**
 * Lives here rather than beside the preview because this is where the sinks
 * are exercised as a group; the behaviour under test is the one the pipeline
 * relies on when it blanks every sink at once.
 */
describe("CanvasPreviewSink.clear", () => {
  it("blanks the preview so it agrees with the blanked device", () => {
    const canvas = fakeCanvas();
    const preview = new CanvasPreviewSink(canvas.element, { width: 4, height: 4 });

    const bitmap: Bitmap = { width: 4, height: 4, data: new Uint8Array(16).fill(1) };
    preview.renderFrame(bitmap);
    preview.renderText("20.0 of 40.0 mm");
    canvas.reset();
    preview.renderFrame(bitmap);
    expect(canvas.raised()).toBe(16);

    canvas.reset();
    preview.clear();

    expect(canvas.raised()).toBe(0);
    // The device's braille line goes down with its graphic area -- the SDK's
    // blanking call writes zeros to both -- so a retained label here would
    // show a line the device no longer has.
    expect(preview.text).toBe("");
  });
});
