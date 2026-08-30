/**
 * Main-thread half of the geometry worker: a typed, promise-based API over
 * `./worker.ts`.
 *
 * The worker owns the WASM module and the parsed mesh; nothing here touches
 * either. All this does is post requests, correlate replies by id, and settle
 * the matching promise.
 */
import type { Bitmap } from "../tactile/types";
import type {
  Bounds,
  GeometryRequest,
  GeometryResponse,
  Rotation,
} from "./worker";

export type { Bounds, Rotation } from "./worker";

/** Everything `render` needs, minus the plumbing the client fills in. */
export interface RenderRequest {
  rotation: Rotation;
  view: number;
  z: number;
  width: number;
  height: number;
  filled: boolean;
  mirror: boolean;
}

/**
 * The part of `Worker` this client uses.
 *
 * Narrowing it to this lets the tests inject a plain object: `new Worker` in a
 * unit test needs either a jsdom shim or a mock elaborate enough that it tests
 * itself rather than the code. A real `Worker` satisfies this structurally.
 */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: { data: GeometryResponse }) => void) | null;
  terminate(): void;
}

/**
 * The real worker. `new Worker(new URL("./worker.ts", import.meta.url), ...)`
 * written out literally like this is the form Vite recognises and bundles; a
 * computed URL or a wrapper around it is left alone and breaks in production.
 */
function spawnWorker(): WorkerLike {
  return new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as WorkerLike;
}

interface Pending {
  resolve: (value: never) => void;
  reject: (reason: Error) => void;
}

export class GeometryClient {
  private worker: WorkerLike | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private disposed = false;

  /**
   * @param createWorker Injectable so tests can substitute a fake. Defaults to
   * the real worker; the worker is not spawned until the first request, so
   * constructing a client costs nothing.
   */
  constructor(private readonly createWorker: () => WorkerLike = spawnWorker) {}

  /** Requests posted but not yet settled. Exposed for tests and diagnostics. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Load an STL and return its triangle count.
   *
   * `bytes` is TRANSFERRED, not copied: a 50 MB STL is worth not duplicating,
   * but the caller's buffer is detached and unusable afterwards. Read the
   * `File` again to re-parse; do not cache the `ArrayBuffer`.
   */
  parse(bytes: ArrayBuffer): Promise<number> {
    return this.request<number>(
      (id) => ({ kind: "parse", id, bytes }),
      [bytes],
    );
  }

  /** The bounds of the loaded mesh under this rotation and view. */
  bounds(rotation: Rotation, view: number): Promise<Bounds> {
    return this.request<Bounds>((id) => ({
      kind: "bounds",
      id,
      rotation,
      view,
    }));
  }

  /** Slice the loaded mesh and rasterize the cross-section to a dot grid. */
  async render(req: RenderRequest): Promise<Bitmap> {
    const data = await this.request<Uint8Array>((id) => ({
      kind: "render",
      id,
      ...req,
    }));
    const expected = req.width * req.height;
    if (data.length !== expected) {
      // Can only happen if the two halves of the protocol disagree. Fail
      // loudly rather than handing a mis-sized grid to the display.
      throw new Error(
        `the renderer returned ${data.length} bytes, expected ${expected}`,
      );
    }
    return { width: req.width, height: req.height, data };
  }

  /**
   * Terminate the worker and reject anything still in flight.
   *
   * Without the rejection, a promise awaited by the UI would hang forever with
   * nothing left to settle it.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    const stranded = [...this.pending.values()];
    this.pending.clear();
    for (const p of stranded) {
      p.reject(new Error("the geometry worker was disposed"));
    }
  }

  private request<T>(
    build: (id: number) => GeometryRequest,
    transfer?: Transferable[],
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error("the geometry worker was disposed"));
    }
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: never) => void,
        reject,
      });
      try {
        worker.postMessage(build(id), transfer);
      } catch (e) {
        // A synchronous postMessage failure (a detached buffer, say) would
        // otherwise leave the entry pending forever.
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private ensureWorker(): WorkerLike {
    if (this.worker === null) {
      const worker = this.createWorker();
      worker.onmessage = (ev) => this.receive(ev.data);
      this.worker = worker;
    }
    return this.worker;
  }

  private receive(response: GeometryResponse): void {
    const entry = this.pending.get(response.id);
    // An unknown id — a late reply for a request already settled, or a stray
    // message — is ignored rather than thrown on: a throw here escapes into
    // the worker's message handler where nothing can catch it.
    if (entry === undefined) return;
    // Delete BEFORE settling, so the map never retains a settled entry even if
    // a `.then` handler runs re-entrantly.
    this.pending.delete(response.id);
    if (response.ok) {
      (entry.resolve as (value: unknown) => void)(response.value);
    } else {
      // The message text comes from the Rust side and is written to be read
      // aloud to the user. It is carried through unchanged.
      entry.reject(new Error(response.error));
    }
  }
}
