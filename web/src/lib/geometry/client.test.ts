import { describe, expect, it, vi } from "vitest";
import { GeometryClient, type WorkerLike } from "./client";
import type { GeometryRequest, GeometryResponse } from "./worker";

/**
 * A stand-in for the real `Worker`.
 *
 * Correlating replies by id is the only part of the client with real
 * behaviour, so that is what these tests exercise. Mocking `new Worker` itself
 * would mostly test the mock; the worker module is verified by the app
 * building and running.
 */
class FakeWorker implements WorkerLike {
  readonly posted: GeometryRequest[] = [];
  readonly transfers: (Transferable[] | undefined)[] = [];
  terminated = 0;
  onmessage: ((ev: { data: GeometryResponse }) => void) | null = null;

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.posted.push(message as GeometryRequest);
    this.transfers.push(transfer);
  }

  terminate(): void {
    this.terminated++;
  }

  /** Deliver a reply the way the real worker would. */
  respond(response: GeometryResponse): void {
    this.onmessage?.({ data: response });
  }
}

function setup() {
  const worker = new FakeWorker();
  const client = new GeometryClient(() => worker);
  return { worker, client };
}

describe("GeometryClient", () => {
  it("resolves the promise matching the response id", async () => {
    const { worker, client } = setup();
    const p = client.parse(new ArrayBuffer(8));
    expect(worker.posted).toHaveLength(1);
    worker.respond({ id: worker.posted[0].id, ok: true, value: 42 });
    await expect(p).resolves.toBe(42);
  });

  it("transfers the buffer rather than copying it", async () => {
    const { worker, client } = setup();
    const bytes = new ArrayBuffer(8);
    const p = client.parse(bytes);
    expect(worker.transfers[0]).toEqual([bytes]);
    worker.respond({ id: worker.posted[0].id, ok: true, value: 1 });
    await p;
  });

  it("settles two concurrent requests independently and in the right pairing", async () => {
    const { worker, client } = setup();
    const a = client.parse(new ArrayBuffer(4));
    const b = client.bounds([0, 0, 0], 0);
    const [idA, idB] = worker.posted.map((r) => r.id);
    expect(idA).not.toBe(idB);

    // Reply out of order: correlation is by id, not by arrival order.
    const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 2, z: 3 } };
    worker.respond({ id: idB, ok: true, value: bounds });
    await expect(b).resolves.toEqual(bounds);

    let aSettled = false;
    void a.then(() => (aSettled = true));
    await Promise.resolve();
    expect(aSettled).toBe(false);

    worker.respond({ id: idA, ok: true, value: 7 });
    await expect(a).resolves.toBe(7);
  });

  it("does not settle other promises when one response arrives", async () => {
    const { worker, client } = setup();
    const a = client.parse(new ArrayBuffer(4));
    const b = client.parse(new ArrayBuffer(4));
    worker.respond({ id: worker.posted[0].id, ok: true, value: 1 });
    await expect(a).resolves.toBe(1);
    expect(client.pendingCount).toBe(1);
    worker.respond({ id: worker.posted[1].id, ok: true, value: 2 });
    await expect(b).resolves.toBe(2);
  });

  it("rejects with the worker's message text when ok is false", async () => {
    const { worker, client } = setup();
    const p = client.parse(new ArrayBuffer(4));
    worker.respond({
      id: worker.posted[0].id,
      ok: false,
      error: "this does not look like an STL file, or it is incomplete",
    });
    await expect(p).rejects.toThrow(
      "this does not look like an STL file, or it is incomplete",
    );
  });

  it("ignores a response with an unknown id without throwing", async () => {
    const { worker, client } = setup();
    const p = client.parse(new ArrayBuffer(4));
    expect(() => worker.respond({ id: 9999, ok: true, value: 1 })).not.toThrow();
    expect(client.pendingCount).toBe(1);
    worker.respond({ id: worker.posted[0].id, ok: true, value: 5 });
    await expect(p).resolves.toBe(5);
  });

  it("ignores a second response for an id that already settled", async () => {
    const { worker, client } = setup();
    const p = client.parse(new ArrayBuffer(4));
    const id = worker.posted[0].id;
    worker.respond({ id, ok: true, value: 3 });
    await expect(p).resolves.toBe(3);
    expect(() => worker.respond({ id, ok: false, error: "late" })).not.toThrow();
  });

  it("does not retain settled entries", async () => {
    const { worker, client } = setup();
    const a = client.parse(new ArrayBuffer(4));
    const b = client.render({
      rotation: [0, 0, 0],
      view: 0,
      z: 0,
      width: 2,
      height: 2,
      filled: true,
      mirror: false,
    });
    expect(client.pendingCount).toBe(2);
    worker.respond({ id: worker.posted[0].id, ok: true, value: 1 });
    worker.respond({
      id: worker.posted[1].id,
      ok: true,
      value: new Uint8Array([0, 1, 1, 0]),
    });
    await Promise.all([a, b]);
    expect(client.pendingCount).toBe(0);
  });

  it("does not retain an entry it rejected", async () => {
    const { worker, client } = setup();
    const p = client.parse(new ArrayBuffer(4));
    worker.respond({ id: worker.posted[0].id, ok: false, error: "nope" });
    await expect(p).rejects.toThrow("nope");
    expect(client.pendingCount).toBe(0);
  });

  it("builds a Bitmap from the requested size and the returned bytes", async () => {
    const { worker, client } = setup();
    const p = client.render({
      rotation: [10, 20, 30],
      view: 1,
      z: 5,
      width: 4,
      height: 2,
      filled: false,
      mirror: true,
    });
    const req = worker.posted[0];
    expect(req).toMatchObject({
      kind: "render",
      rotation: [10, 20, 30],
      view: 1,
      z: 5,
      width: 4,
      height: 2,
      filled: false,
      mirror: true,
    });
    const data = new Uint8Array([1, 0, 1, 0, 0, 1, 0, 1]);
    worker.respond({ id: req.id, ok: true, value: data });
    await expect(p).resolves.toEqual({ width: 4, height: 2, data });
  });

  it("rejects a render whose byte count does not match the requested size", async () => {
    const { worker, client } = setup();
    const p = client.render({
      rotation: [0, 0, 0],
      view: 0,
      z: 0,
      width: 4,
      height: 2,
      filled: true,
      mirror: false,
    });
    worker.respond({
      id: worker.posted[0].id,
      ok: true,
      value: new Uint8Array(3),
    });
    await expect(p).rejects.toThrow(/3/);
    expect(client.pendingCount).toBe(0);
  });

  it("terminates the worker and rejects everything in flight on dispose", async () => {
    const { worker, client } = setup();
    const p = client.parse(new ArrayBuffer(4));
    client.dispose();
    expect(worker.terminated).toBe(1);
    await expect(p).rejects.toThrow(/disposed/i);
    expect(client.pendingCount).toBe(0);
  });

  it("rejects requests made after dispose", async () => {
    const { client } = setup();
    client.dispose();
    await expect(client.parse(new ArrayBuffer(4))).rejects.toThrow(/disposed/i);
    await expect(client.bounds([0, 0, 0], 0)).rejects.toThrow(/disposed/i);
  });

  it("disposes only once", async () => {
    const { worker, client } = setup();
    const p = client.parse(new ArrayBuffer(4));
    client.dispose();
    client.dispose();
    expect(worker.terminated).toBe(1);
    await expect(p).rejects.toThrow(/disposed/i);
  });

  it("creates the worker lazily, and only once", async () => {
    const worker = new FakeWorker();
    const factory = vi.fn(() => worker);
    const client = new GeometryClient(factory);
    expect(factory).not.toHaveBeenCalled();
    const a = client.parse(new ArrayBuffer(4));
    expect(factory).toHaveBeenCalledTimes(1);
    const b = client.bounds([0, 0, 0], 0);
    expect(factory).toHaveBeenCalledTimes(1);
    client.dispose();
    await expect(a).rejects.toThrow(/disposed/i);
    await expect(b).rejects.toThrow(/disposed/i);
  });
});
