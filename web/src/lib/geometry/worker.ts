/**
 * Owns the WASM module and the currently loaded mesh.
 *
 * Parsing a 50 MB STL takes long enough to freeze the page, so the module and
 * the mesh live here and the `MeshHandle` never crosses back to the main
 * thread. The main thread talks to this worker only through `GeometryClient`
 * (`./client.ts`), which correlates replies by `id`.
 */
import init, { parse_stl, type MeshHandle } from "../wasm/tactistl_wasm";

/** A rotation in degrees about the x, y and z axes, applied in that order. */
export type Rotation = [number, number, number];

/** Axis-aligned bounds of the rotated mesh, in model units. */
export interface Bounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/**
 * Load an STL. The `ArrayBuffer` is transferred, not copied, so the sender's
 * copy is detached once this is posted.
 */
export interface ParseMessage {
  kind: "parse";
  id: number;
  bytes: ArrayBuffer;
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
 * execution makes "free the old handle, then take the new one" a single
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
        // Free BEFORE parsing: wasm32 linear memory only ever grows, so
        // holding both meshes at once would raise the module's high-water mark
        // permanently. Nulling first also means a failed parse leaves no
        // dangling freed handle for the next request to free again.
        mesh?.free();
        mesh = null;
        const parsed = parse_stl(new Uint8Array(req.bytes));
        mesh = parsed;
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
