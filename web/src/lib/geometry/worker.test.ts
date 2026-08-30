/**
 * Mesh ownership across a parse.
 *
 * The worker holds one WASM handle and has to free the old one when a new
 * model arrives. Which side of the parse that free happens on decides what a
 * BAD file costs the user: free first and a failed parse takes the working
 * model down with it, leaving an app that says a model is loaded while every
 * render answers "no model is loaded".
 *
 * `worker.ts` is a module with side effects -- it reads `self` and installs an
 * `onmessage` at import -- so it is driven here the way the browser drives it,
 * through a fake scope, with the WASM module mocked out. The mock is a factory
 * rather than a spy on the real thing, so this test does not need
 * `src/lib/wasm/` to have been generated and `npm test` stays runnable on a
 * fresh clone.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { GeometryResponse } from "./worker";

/** Names of the handles whose `free()` has been called, in order. */
const freed: string[] = [];

class FakeMesh {
  constructor(private readonly name: string) {}
  free(): void {
    freed.push(this.name);
  }
  bounds(): Float32Array {
    return new Float32Array([0, 0, 0, 1, 1, 1]);
  }
  render(): Uint8Array {
    return new Uint8Array(4);
  }
  get triangle_count(): number {
    return 7;
  }
}

/** What the next `parse_stl` call does. Swapped per step below. */
let nextParse: () => FakeMesh = () => new FakeMesh("unset");

vi.mock("../wasm/tactistl_wasm", () => ({
  default: () => Promise.resolve({}),
  parse_stl: () => nextParse(),
}));

const replies: GeometryResponse[] = [];

interface FakeScope {
  postMessage(message: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

const scope: FakeScope = {
  postMessage: (message) => {
    replies.push(message as GeometryResponse);
  },
  onmessage: null,
};

/** Post a request and let the worker's internal queue drain. */
async function send(request: unknown): Promise<GeometryResponse> {
  scope.onmessage?.({ data: request });
  // The worker chains every request onto a promise queue behind an `await` for
  // WASM init, so several microtask turns pass before a reply lands.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return replies[replies.length - 1];
}

describe("the geometry worker's mesh ownership", () => {
  beforeAll(async () => {
    (globalThis as unknown as { self: FakeScope }).self = scope;
    // Imported after `self` exists: the module reads it at evaluation time.
    await import("./worker");
  });

  // These run in order against ONE module instance, because the worker's mesh
  // is module state and there is no way to reset it but to load another model.
  it("loads a model", async () => {
    nextParse = () => new FakeMesh("first");
    const reply = await send({ kind: "parse", id: 1, bytes: new ArrayBuffer(4) });
    expect(reply).toMatchObject({ id: 1, ok: true, value: 7 });
    expect(freed).toEqual([]);
  });

  it("leaves the loaded model live and usable when a parse fails", async () => {
    nextParse = () => {
      throw new Error("this does not look like an STL file");
    };
    const failed = await send({ kind: "parse", id: 2, bytes: new ArrayBuffer(4) });
    expect(failed).toEqual({
      id: 2,
      ok: false,
      // Carried through unchanged: the Rust text is written to be read aloud.
      error: "this does not look like an STL file",
    });
    // Nothing was released, so the previous model still answers.
    expect(freed).toEqual([]);
    const bounds = await send({ kind: "bounds", id: 3, rotation: [0, 0, 0], view: 0 });
    expect(bounds).toMatchObject({ id: 3, ok: true });
  });

  it("frees the mesh it replaces once a parse succeeds", async () => {
    nextParse = () => new FakeMesh("second");
    const reply = await send({ kind: "parse", id: 4, bytes: new ArrayBuffer(4) });
    expect(reply).toMatchObject({ id: 4, ok: true });
    expect(freed).toEqual(["first"]);
  });
});
