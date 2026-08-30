import { describe, expect, it } from "vitest";
import type { Bounds, RenderRequest } from "./geometry/client";
import { startPipeline } from "./pipeline";
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
    expect(g.requests).toHaveLength(1);

    // 40 scrubber positions while the first render is still in flight.
    for (let i = 1; i <= 40; i++) store.setAxisPos(i);
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
    g.release();
    await flush();

    store.setRotation("x", 15);
    store.setRotation("y", -30);
    store.setRotation("z", 90);
    store.setView(ViewAxis.Side);
    store.setMirror(true);
    store.setFilled(true);
    store.setAxisPos(7);
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
    g.release();
    await flush();

    sink.grid = { width: 40, height: 20 };
    store.setConnected(true);
    g.release();
    await flush();

    expect(g.requests).toHaveLength(2);
    expect(g.requests[1].width).toBe(40);
    expect(g.requests[1].height).toBe(20);
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
