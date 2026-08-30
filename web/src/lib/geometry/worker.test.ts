/**
 * Mesh ownership across a parse.
 *
 * The worker holds one WASM handle and has to free the old one when a new
 * model arrives. Which side of the parse that free happens on decides what a
 * BAD file costs the user: free first and a failed parse takes the working
 * model down with it, leaving an app that says a model is loaded while every
 * render answers "no model is loaded".
 *
 * The parse is also a streaming one now, and the `StlStream` it feeds is a
 * WASM heap object: it has to be freed on every path, the failing one
 * included, or every rejected file leaks its buffer for the life of the page.
 * That is asserted below alongside the mesh ownership.
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

/** What the next `finish()` does. Swapped per step below. */
let nextParse: () => FakeMesh = () => new FakeMesh("unset");

/** Every chunk handed to `push`, concatenated, for the last parse. */
let pushed: number[] = [];
/** How many `StlStream`s have been constructed and how many freed. */
let streamsMade = 0;
let streamsFreed = 0;
/** The total length each `StlStream` was constructed with. */
const declaredLengths: number[] = [];

class FakeStream {
  constructor(totalLen: number) {
    streamsMade++;
    declaredLengths.push(totalLen);
    pushed = [];
  }
  push(chunk: Uint8Array): void {
    pushed.push(...chunk);
  }
  finish(): FakeMesh {
    return nextParse();
  }
  free(): void {
    streamsFreed++;
  }
}

vi.mock("../wasm/tactistl_wasm", () => ({
  default: () => Promise.resolve({}),
  StlStream: class {
    constructor(totalLen: number) {
      return new FakeStream(totalLen) as unknown as object;
    }
  },
}));

/**
 * A `File` stand-in that streams `bytes` in small pieces.
 *
 * Deliberately more than one chunk: the worker's read loop is the part being
 * exercised, and a single-chunk fake would pass even if the loop only ever ran
 * once.
 */
function fakeFile(bytes: number[], chunkSize = 3): File {
  return {
    name: "model.stl",
    size: bytes.length,
    stream() {
      let at = 0;
      return {
        getReader() {
          return {
            read() {
              if (at >= bytes.length) {
                return Promise.resolve({ done: true, value: undefined });
              }
              const value = new Uint8Array(bytes.slice(at, at + chunkSize));
              at += chunkSize;
              return Promise.resolve({ done: false, value });
            },
          };
        },
      };
    },
  } as unknown as File;
}

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
  it("streams the whole file into the parser and loads the model", async () => {
    nextParse = () => new FakeMesh("first");
    const bytes = [1, 2, 3, 4, 5, 6, 7];
    const reply = await send({ kind: "parse", id: 1, file: fakeFile(bytes) });
    expect(reply).toMatchObject({ id: 1, ok: true, value: 7 });
    // Every byte arrived, in order, across several chunks -- nothing dropped
    // at a chunk boundary and nothing fed twice.
    expect(pushed).toEqual(bytes);
    // The parser was told the size up front, which is what lets it decide the
    // format and size its allocation from the first 84 bytes.
    expect(declaredLengths.at(-1)).toBe(bytes.length);
    expect(freed).toEqual([]);
    expect(streamsFreed).toBe(streamsMade);
  });

  it("leaves the loaded model live and usable when a parse fails", async () => {
    nextParse = () => {
      throw new Error("this does not look like an STL file");
    };
    const failed = await send({ kind: "parse", id: 2, file: fakeFile([1, 2, 3]) });
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
    const reply = await send({ kind: "parse", id: 4, file: fakeFile([1, 2, 3]) });
    expect(reply).toMatchObject({ id: 4, ok: true });
    expect(freed).toEqual(["first"]);
  });

  /**
   * The parser is a WASM heap object, and a rejected file is the common case:
   * the user grabs the wrong thing from a folder they cannot see. If the free
   * is skipped on that path, every mistaken pick permanently costs whatever
   * the parser had buffered, because wasm32 memory is never given back.
   */
  it("frees the parser on every path, including a failed parse", async () => {
    expect(streamsFreed).toBe(streamsMade);
    const before = streamsMade;

    nextParse = () => {
      throw new Error("this STL contains invalid coordinates");
    };
    await send({ kind: "parse", id: 5, file: fakeFile([1, 2, 3]) });
    expect(streamsMade).toBe(before + 1);
    expect(streamsFreed).toBe(streamsMade);

    // And when the file itself fails to read, so the throw comes from the
    // stream rather than from the parser.
    const broken = {
      name: "gone.stl",
      size: 10,
      stream: () => ({
        getReader: () => ({
          read: () => Promise.reject(new Error("the file could not be read")),
        }),
      }),
    } as unknown as File;
    const reply = await send({ kind: "parse", id: 6, file: broken });
    expect(reply).toMatchObject({ id: 6, ok: false });
    expect(streamsFreed).toBe(streamsMade);
  });
});
