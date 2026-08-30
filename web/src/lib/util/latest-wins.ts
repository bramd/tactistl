/**
 * Runs at most one send at a time; a newly submitted item replaces any item
 * still waiting.
 *
 * Scrubbing a slider produces a value per pixel of travel. Without this, every
 * intermediate value would be queued and the consumer would spend seconds
 * replaying stale state after the user has already stopped. With it, the
 * consumer always converges on the newest value.
 *
 * Guarantees:
 * - At most one send is in flight; sends are strictly sequential and never
 *   interleaved.
 * - Every DEQUEUED item is attempted exactly once.
 * - The most recently submitted item is eventually attempted exactly once,
 *   PROVIDED every send settles.
 *
 * Explicitly NOT guaranteed:
 * - That every submitted item is sent. Intermediate items are dropped by
 *   design; this is not a queue that delivers everything.
 * - That a failed item is ever sent. An item whose send REJECTS is reported to
 *   `onError` and is not retried.
 * - Progress at all, if a send never settles: that stalls the queue
 *   permanently, and every later submission is dropped.
 *
 * Two consequences for callers, both real for this app:
 * - A transport write with no timeout can wedge the queue forever. Impose the
 *   timeout at the transport, not here.
 * - The final frame of a drag has no retry behind it, and it is the frame the
 *   user is waiting to feel. A caller that needs the last item delivered must
 *   arrange that itself.
 *
 * `submit` returns void: there is no backpressure and no completion signal.
 */
export class LatestWinsQueue<T> {
  private pending: { item: T } | null = null;
  private running = false;

  constructor(
    private readonly send: (item: T) => Promise<void>,
    /**
     * Called when a send rejects. Failures must not stall the queue.
     *
     * The default logs rather than swallowing, because this app's user is
     * blind: they cannot see that the tactile display has gone stale, so a
     * silently dropped send is indistinguishable from geometry that genuinely
     * did not change — and the consequence is carrying a wrong orientation all
     * the way to a print, which is the exact failure this tool exists to
     * prevent. Logging is a floor, not the real handling: the Dot Pad call site
     * is expected to pass a handler that surfaces the failure accessibly.
     */
    private readonly onError: (e: unknown) => void = (e) =>
      console.error("LatestWinsQueue: send failed", e),
  ) {}

  get busy(): boolean {
    return this.running;
  }

  submit(item: T): void {
    this.pending = { item };
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending !== null) {
        const { item } = this.pending;
        this.pending = null;
        try {
          await this.send(item);
        } catch (e) {
          this.onError(e);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
