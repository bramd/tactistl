/**
 * Runs at most one send at a time; a newly submitted item replaces any item
 * still waiting.
 *
 * Scrubbing a slider produces a value per pixel of travel. Without this, every
 * intermediate value would be queued and the consumer would spend seconds
 * replaying stale state after the user has already stopped. With it, the
 * consumer always converges on the newest value.
 */
export class LatestWinsQueue<T> {
  private pending: { item: T } | null = null;
  private running = false;

  constructor(
    private readonly send: (item: T) => Promise<void>,
    /** Called when a send rejects. Failures must not stall the queue. */
    private readonly onError: (e: unknown) => void = () => {},
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
