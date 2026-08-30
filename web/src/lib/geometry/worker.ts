/**
 * Owns the WASM module and the currently loaded mesh.
 *
 * Parsing a 50 MB STL takes long enough to freeze the page, so the module and
 * the mesh live here and the `MeshHandle` never crosses back to the main
 * thread. The main thread talks to this worker only through `GeometryClient`
 * (`./client.ts`), which correlates replies by `id`.
 */
import init, { StlStream, type MeshHandle } from "../wasm/tactistl_wasm";

/** A rotation in degrees about the x, y and z axes, applied in that order. */
export type Rotation = [number, number, number];

/** Axis-aligned bounds of the rotated mesh, in model units. */
export interface Bounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/**
 * Load an STL.
 *
 * The `File` itself is posted, not its bytes. A `File` is structured-cloneable
 * and stays disk-backed, so cloning it into the worker copies a handle rather
 * than the data: the file never lands in the JavaScript heap on either side.
 * The worker streams it in chunks straight into the parser.
 */
export interface ParseMessage {
  kind: "parse";
  id: number;
  file: File;
}

/** Bounds of the loaded mesh under a rotation and view. */
export interface BoundsMessage {
  kind: "bounds";
  id: number;
  rotation: Rotation;
  view: number;
}

/** Slice the loaded mesh at `z` and rasterize to a `width` x `height` grid. */
export interface RenderMessage {
  kind: "render";
  id: number;
  rotation: Rotation;
  view: number;
  z: number;
  width: number;
  height: number;
  filled: boolean;
  mirror: boolean;
}

export type GeometryRequest = ParseMessage | BoundsMessage | RenderMessage;

/**
 * A reply always echoes the request's `id`, and is always exactly one of these
 * two shapes: every failure path, including an unexpected internal one, is
 * converted to `ok: false`. An uncaught throw inside a worker is invisible to
 * the caller and would leave its promise pending forever.
 */
export type GeometryResponse =
  | { id: number; ok: true; value: GeometryValue }
  | { id: number; ok: false; error: string };

/**
 * `parse` yields the triangle count, `bounds` the rotated bounds, `render` the
 * raw `width * height` dot bytes. The client knows which it asked for and
 * narrows accordingly; the width and height of a render are not echoed back
 * because the client still holds the request it sent.
 */
export type GeometryValue = number | Bounds | Uint8Array;

/** The subset of `DedicatedWorkerGlobalScope` this module uses. */
interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}

const scope = self as unknown as WorkerScope;

/** Cached so the module is instantiated once, on the first request. */
let ready: Promise<unknown> | null = null;

function ensureReady(): Promise<unknown> {
  ready ??= init();
  return ready;
}

let mesh: MeshHandle | null = null;

/**
 * Requests run strictly one at a time.
 *
 * Without this, two `parse` messages arriving back to back would both suspend
 * at the `await` for WASM init and resume interleaved, and the ownership of
 * `mesh` — who frees which handle — would depend on microtask ordering. Serial
 * execution makes "take the new handle, then free the old one" a single
 * indivisible step, so a handle is never freed twice and a live handle is
 * never freed.
 */
let queue: Promise<void> = Promise.resolve();

function requireMesh(): MeshHandle {
  if (mesh === null) throw new Error("no model is loaded");
  return mesh;
}

function toBounds(b: Float32Array): Bounds {
  return {
    min: { x: b[0], y: b[1], z: b[2] },
    max: { x: b[3], y: b[4], z: b[5] },
  };
}

async function handle(req: GeometryRequest): Promise<void> {
  try {
    await ensureReady();
    switch (req.kind) {
      case "parse": {
        // Stream the file into the parser instead of handing WASM one big
        // slice. A whole-buffer entry point would need the file resident twice
        // over -- the JS buffer plus wasm-bindgen's copy into linear memory --
        // and wasm32 memory is never returned to the browser, so both copies
        // are a permanent cost. Chunks cost one chunk. That is why no such
        // export exists: wasm-bindgen makes its copy before any Rust code, and
        // therefore any budget check, can run, so an oversized input aborts the
        // module outright instead of being refused with a sentence.
        //
        // `StlStream` is a WASM heap object, so it must be freed on EVERY
        // path. The `finally` covers a rejected parse and a stream that throws
        // mid-read; without it each refused file would leak its buffer for the
        // lifetime of the page.
        const parser = new StlStream(req.file.size);
        let parsed: MeshHandle;
        try {
          const reader = req.file.stream().getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parser.push(value);
          }
          // Parse into a temporary, and only free the old handle once the new
          // one exists. A failed parse therefore throws before anything is
          // released, leaving the previously loaded model live and renderable.
          //
          // The cost is deliberate: on the SUCCESS path both meshes are
          // briefly resident, and wasm32 linear memory only ever grows, so the
          // module's high-water mark is set by the largest pair rather than
          // the largest single mesh and never comes back down. Freeing first
          // would avoid that, at the price of destroying the loaded model every
          // time a parse fails -- and this app exists for a user who cannot
          // glance at a file picker to check they grabbed the right file. An
          // app that survives a fumbled selection is worth more than a lower
          // ceiling.
          parsed = parser.finish();
        } finally {
          parser.free();
        }
        // Past the throwing calls: from here the swap cannot fail partway.
        const previous = mesh;
        mesh = parsed;
        previous?.free();
        reply({ id: req.id, ok: true, value: parsed.triangle_count });
        return;
      }
      case "bounds": {
        const [rx, ry, rz] = req.rotation;
        const b = requireMesh().bounds(rx, ry, rz, req.view);
        reply({ id: req.id, ok: true, value: toBounds(b) });
        return;
      }
      case "render": {
        const [rx, ry, rz] = req.rotation;
        // wasm-bindgen returns a copy, not a view into WASM memory, so this
        // can be transferred without a defensive copy of our own.
        const data = requireMesh().render(
          rx,
          ry,
          rz,
          req.view,
          req.z,
          req.width,
          req.height,
          req.filled,
          req.mirror,
        );
        reply({ id: req.id, ok: true, value: data }, [data.buffer]);
        return;
      }
    }
  } catch (e) {
    // The Rust side's messages ("this does not look like an STL file, or it is
    // incomplete", ...) are written to be read aloud to the user, so pass the
    // text through unchanged rather than substituting a generic one.
    reply({
      id: req.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function reply(response: GeometryResponse, transfer?: Transferable[]): void {
  scope.postMessage(response, transfer);
}

scope.onmessage = (ev: MessageEvent) => {
  const req = ev.data as GeometryRequest;
  // `handle` never rejects, but chain defensively: a rejected `queue` would
  // stall every later request silently.
  queue = queue.then(() => handle(req)).catch(() => {});
};
