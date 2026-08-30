import { describe, expect, it } from "vitest";
import { LatestWinsQueue } from "./latest-wins";

/** A send function whose completion the test controls. */
function controllable() {
  const sent: number[] = [];
  let release: (() => void) | null = null;
  const send = (n: number) =>
    new Promise<void>((resolve) => {
      sent.push(n);
      release = resolve;
    });
  return {
    sent,
    send,
    finish() {
      const r = release;
      release = null;
      r?.();
    },
  };
}

describe("LatestWinsQueue", () => {
  it("sends the first item immediately", async () => {
    const c = controllable();
    const q = new LatestWinsQueue(c.send);
    q.submit(1);
    expect(c.sent).toEqual([1]);
  });

  it("drops everything but the newest item while one is in flight", async () => {
    const c = controllable();
    const q = new LatestWinsQueue(c.send);
    q.submit(1);
    q.submit(2);
    q.submit(3);
    q.submit(4);
    q.submit(5);
    expect(c.sent).toEqual([1]);

    c.finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(c.sent).toEqual([1, 5]);
  });

  it("goes idle after the last item drains", async () => {
    const c = controllable();
    const q = new LatestWinsQueue(c.send);
    q.submit(1);
    c.finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(c.sent).toEqual([1]);
    expect(q.busy).toBe(false);
  });

  it("returns to idle after a send rejects, then runs the next item in a fresh cycle", async () => {
    let calls = 0;
    const sent: number[] = [];
    const errors: unknown[] = [];
    const q = new LatestWinsQueue<number>(async (n) => {
      calls++;
      if (calls === 1) throw new Error("transport blew up");
      sent.push(n);
    }, (e) => errors.push(e));
    q.submit(1);
    await Promise.resolve();
    await Promise.resolve();
    // Assert recovery BEFORE submitting again. Without this the test passes
    // even if the queue never recovered: item 2 would be picked up by
    // coalescing inside the still-running first pump, which proves nothing
    // about recovery.
    expect(errors).toHaveLength(1);
    expect(q.busy).toBe(false);

    q.submit(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([2]);
  });
});
