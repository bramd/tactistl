<script lang="ts">
  import { onMount } from "svelte";
  import ModelLoader from "./lib/components/ModelLoader.svelte";
  import RotationControls from "./lib/components/RotationControls.svelte";
  import ViewControls from "./lib/components/ViewControls.svelte";
  import AxisScrubber from "./lib/components/AxisScrubber.svelte";
  import ConnectionControls from "./lib/components/ConnectionControls.svelte";
  import { GeometryClient } from "./lib/geometry/client";
  import { DotPadSink, type ExpectedBufferMode } from "./lib/dotpad/sink";
  import { CanvasPreviewSink } from "./lib/tactile/preview";
  import { startPipeline } from "./lib/pipeline";
  import { createViewerStore, type ViewAxisValue } from "./lib/store";
  import type { Transport } from "./lib/tactile/types";

  /**
   * The only place that orchestrates.
   *
   * Every child is a dumb pair of "here are the values" and "here is what to
   * call"; all of the async work, all of the store writes and the whole device
   * lifecycle live here. That is deliberate: the two mistakes that would be
   * invisible to the user this is built for -- calling `boundsChanged` where
   * `viewChanged` belongs, and forgetting `setConnected` after a successful
   * connect -- are both in this file, near each other, where they can be read
   * side by side.
   */

  const viewer = createViewerStore();
  // A nested store cannot be reached through `$viewer`, so it is lifted out to
  // its own top-level binding to be auto-subscribed.
  const axisLabel = viewer.axisLabel;

  let canvasEl: HTMLCanvasElement;
  let geometry: GeometryClient | null = null;
  let dotpad: DotPadSink | null = null;

  /** The polite live region's text. Nothing else writes to it. */
  let announcement = $state("");
  let transports = $state<Transport[]>([]);
  let active = $state<Transport | null>(null);

  /**
   * What the connected device calls itself, and the packet strategy the SDK
   * derives from that name. Mirrored into state because the sink is a plain
   * class and nothing here would re-render on a change to its properties.
   *
   * Both are read straight after `connect()` resolves: in 3.0.2 the SDK asks
   * for the name as part of its own connection handshake and does not report
   * `Connected` until the answer is in, so it is already known by then.
   */
  let deviceName = $state<string | null>(null);
  let bufferMode = $state<ExpectedBufferMode | null>(null);

  /**
   * Guards against an out-of-order bounds reply.
   *
   * One counter across BOTH rotation and view fetches, not one each: a
   * rotation request that resolves after a later view change must not apply
   * `boundsChanged` on top of the `viewChanged` that superseded it. Only the
   * fetch still holding the latest token is allowed to write.
   */
  let latestBounds = 0;

  function announce(text: string): void {
    announcement = text;
  }

  function message(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  /**
   * The one way a failure reaches the user. `setError` clears `busy` itself,
   * so there is nothing to remember to pair with it here.
   */
  function fail(e: unknown): void {
    viewer.setError(message(e));
  }

  async function loadFile(file: File): Promise<void> {
    const client = geometry;
    // Re-entrancy is guarded on the state, not by disabling the file input:
    // disabling the element the user is standing on drops focus to <body>, and
    // for a 50 MB STL that is seconds with no focus at all -- on the single
    // most repeated interaction in the app. The drop handler guards the same
    // way, so both entry points behave alike.
    if (!client || viewer.snapshot().busy) return;
    viewer.setBusy(true);
    try {
      // The `File` goes to the worker untouched: it is structured-cloneable
      // and disk-backed, so this reads none of it here. The worker streams it
      // into the parser, which is what keeps a large STL from costing two full
      // copies of itself in memory.
      const triangles = await client.parse(file);
      const s = viewer.snapshot();
      const bounds = await client.bounds(
        [s.rotation.x, s.rotation.y, s.rotation.z],
        s.view,
      );
      // A load supersedes any bounds fetch still in flight for the old model.
      latestBounds++;
      viewer.onModelLoaded(triangles, bounds);
      announce(`Loaded ${file.name}: ${triangles.toLocaleString()} triangles.`);
    } catch (e) {
      fail(e);
    }
  }

  /**
   * The two store methods below take the same argument and differ only in what
   * they do to the reading position, so choosing the wrong one produces no
   * error of any kind -- just a scrubber that jumps when it should hold, or
   * holds when it should jump. There are exactly two call sites, both here.
   *
   * ROTATION: `boundsChanged` PRESERVES the reading position as a fraction of
   * the extent. Nudging the rotation a degree to compare must not throw away
   * the plane being read.
   */
  async function refreshBounds(): Promise<void> {
    const client = geometry;
    const s = viewer.snapshot();
    if (!client || !s.modelLoaded) return;
    const token = ++latestBounds;
    try {
      const bounds = await client.bounds(
        [s.rotation.x, s.rotation.y, s.rotation.z],
        s.view,
      );
      if (token !== latestBounds) return;
      viewer.boundsChanged(bounds);
    } catch (e) {
      fail(e);
    }
  }

  function onRotate(axis: "x" | "y" | "z", degrees: number): void {
    viewer.setRotation(axis, degrees);
    void refreshBounds();
  }

  /**
   * A view change, applied only once its own bounds are in hand.
   *
   * The view is deliberately NOT written to the store first. Writing it alone
   * leaves the store holding the new view against the old sweep's position --
   * a plane from an unrelated extent, which renders blank -- and the pipeline
   * wakes on that write. On hardware every frame is roughly a second of
   * mechanical pin actuation, so the user would feel a blank plate, then the
   * real cross-section, with no way to tell which was real.
   *
   * So the bounds are fetched for the REQUESTED view, and only then are the
   * two writes made back to back with nothing awaited between them. The
   * pipeline collapses a synchronous burst of writes into one render, so the
   * device only ever feels the consistent state.
   *
   * VIEW: `viewChanged` RE-CENTRES. Top to Front swaps the sweep onto an
   * unrelated extent, so carrying a fraction across would be meaningless.
   */
  async function onView(view: ViewAxisValue): Promise<void> {
    const client = geometry;
    const s = viewer.snapshot();
    if (!client || !s.modelLoaded) return;
    const token = ++latestBounds;
    try {
      const bounds = await client.bounds(
        [s.rotation.x, s.rotation.y, s.rotation.z],
        view,
      );
      if (token !== latestBounds) return;
      viewer.setView(view);
      viewer.viewChanged(bounds);
    } catch (e) {
      fail(e);
    }
  }

  /**
   * Runs straight out of the click with nothing awaited before `sink.connect`,
   * because both Web Serial and Web Bluetooth open their picker only while the
   * user gesture is still live.
   */
  async function connect(transport: Transport): Promise<void> {
    const sink = dotpad;
    if (!sink) return;
    try {
      await sink.connect(transport);
      // A dismissed picker resolves normally and leaves the sink
      // disconnected. That is the user saying "not now", not a failure.
      if (!sink.connected) return;
      active = transport;
      deviceName = sink.deviceName;
      bufferMode = sink.expectedBufferMode;
      // REQUIRED, not bookkeeping: the pipeline reads the sink's grid on every
      // submission but only wakes on a store change, so this is what makes it
      // re-render at the device's own cell counts instead of leaving the
      // display on the last frame rasterized for the 60x40 fallback.
      viewer.setConnected(true);
      const name = transport === "usb" ? "USB" : "Bluetooth";
      announce(`Connected to the Dot Pad over ${name}.`);
    } catch (e) {
      fail(e);
    }
  }

  async function disconnect(): Promise<void> {
    const sink = dotpad;
    if (!sink) return;
    try {
      await sink.disconnect();
    } catch (e) {
      fail(e);
    }
    active = null;
    deviceName = null;
    bufferMode = null;
    viewer.setConnected(false);
    announce("Disconnected from the Dot Pad.");
  }

  onMount(() => {
    const client = new GeometryClient();
    const sink = new DotPadSink();
    /**
     * The preview takes its grid at construction and has no setter, so it is
     * built at the 60x40 the A320 offers and stays there. A display reporting
     * different cell counts leaves the preview cropped rather than garbled --
     * see the note beside the canvas, which says so on screen.
     */
    const preview = new CanvasPreviewSink(canvasEl);
    geometry = client;
    dotpad = sink;
    transports = sink.availableTransports;

    const offKey = sink.onKey(viewer.handleDeviceKey);
    const offDisconnect = sink.onDisconnect(() => {
      active = null;
      deviceName = null;
      bufferMode = null;
      viewer.setConnected(false);
      announce("The Dot Pad disconnected.");
    });
    const offError = sink.onError((e) => {
      // Routed through the store so it reaches the live region by the same
      // path as every other error, rather than announcing from two places.
      viewer.setError(`The tactile display reported: ${message(e)}`);
    });

    // ORDER MATTERS: the pipeline rasterizes to `sinks[0].grid`, so the real
    // device is first and the preview follows it, never the other way round.
    const stopPipeline = startPipeline(viewer, client, [sink, preview]);

    // Announce every error, wherever it came from -- including the pipeline's
    // own render failures, which have no call site of ours to announce from.
    let lastError: string | null = viewer.snapshot().error;
    const stopErrors = viewer.subscribe((s) => {
      if (s.error === lastError) return;
      lastError = s.error;
      if (s.error !== null) announce(`Error: ${s.error}`);
    });

    return () => {
      stopErrors();
      stopPipeline();
      offKey();
      offDisconnect();
      offError();
      void sink.disconnect();
      client.dispose();
    };
  });
</script>

<main>
  <h1>tactistl</h1>
  <p class="lede">
    Load an STL, orient it, and sweep a cross-section through it. Each
    cross-section goes to a Dot Pad tactile display, so you can check a model's
    orientation by touch before you print it.
  </p>

  <!--
    One polite live region for the whole page.

    It announces what happens without the user having caused it at a control
    they are standing on: a model finishing loading, an error from anywhere
    including the render pipeline, and the display connecting or dropping out.
    It deliberately says NOTHING as the scrubber moves -- the range input
    announces its own value, and a live region firing per tick would talk over
    that continuously through a drag -- and nothing for the checkboxes or the
    view select, which announce themselves natively.
  -->
  <p class="status" role="status" aria-live="polite">{announcement}</p>

  <ModelLoader busy={$viewer.busy} onfile={(f) => void loadFile(f)} />

  <!--
    Disabled while a load is in flight as well as before the first one: a
    rotation committed during a parse would leave the store holding the new
    angle against the bounds of the old one, because the load discards any
    bounds fetch still outstanding when it lands.
  -->
  <section aria-labelledby="orientation-heading">
    <h2 id="orientation-heading">Orientation</h2>
    <RotationControls
      rotation={$viewer.rotation}
      disabled={!$viewer.modelLoaded || $viewer.busy}
      onrotate={onRotate}
    />
    <ViewControls
      view={$viewer.view}
      mirror={$viewer.mirror}
      filled={$viewer.filled}
      disabled={!$viewer.modelLoaded || $viewer.busy}
      onview={(v) => void onView(v)}
      onmirror={viewer.setMirror}
      onfilled={viewer.setFilled}
    />
    <AxisScrubber
      bounds={$viewer.bounds}
      axisPos={$viewer.axisPos}
      label={$axisLabel}
      disabled={!$viewer.modelLoaded || $viewer.busy}
      onpos={viewer.setAxisPos}
    />
  </section>

  <ConnectionControls
    {transports}
    connected={$viewer.connected}
    {active}
    {deviceName}
    {bufferMode}
    onconnect={(t) => void connect(t)}
    ondisconnect={() => void disconnect()}
  />

  <section aria-labelledby="preview-heading">
    <h2 id="preview-heading">Preview</h2>
    <p>
      What a connected display would be showing, for sighted collaborators and
      for working without hardware. It is drawn at 60 by 40 dots, the Dot Pad
      A320's grid; a display with a different grid is shown cropped to that.
    </p>
    <!--
      No `role="img"`: a canvas may not take it, and the paragraph above
      already carries everything the picture says. The label is left on for
      the case where a screen reader does surface the element.
    -->
    <canvas
      bind:this={canvasEl}
      aria-label="Dot grid preview of the current cross-section"
    ></canvas>
  </section>
</main>

<style>
  main {
    max-width: 60rem;
    margin: 0 auto;
    padding: 1rem 1.5rem 4rem;
  }
  .lede {
    max-width: 46rem;
  }
  .status {
    min-height: 1.5em;
    font-weight: 600;
    color: var(--text-h);
  }
  main :global(fieldset) {
    border: 1px solid var(--border);
    margin: 0 0 1rem;
  }
  canvas {
    max-width: 100%;
    border: 1px solid var(--border);
  }
</style>
