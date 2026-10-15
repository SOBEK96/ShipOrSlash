/**
 * SingleFlight: at most one run of `fn` at a time, with explicit rules for what
 * a request that arrives mid-flight means.
 *
 * Why not just setInterval(refresh, 20s)? With a slow RPC (a read that takes
 * longer than the interval) every tick either piles another request on top of
 * the one in flight or, worse, invalidates it, so a slow network yields no
 * data at all. Here:
 *
 *   - `poll()`    a periodic tick. If a run is in flight it is a no-op that
 *                 returns the in-flight promise. It never queues a follow-up,
 *                 so a stalled RPC cannot build a backlog.
 *   - `request()` an explicit ask (Refresh button, a transaction just landed).
 *                 If a run is in flight, exactly ONE follow-up run is queued
 *                 for after it finishes, because the in-flight read began
 *                 before the thing that prompted this request.
 *
 * However many requests arrive, the queue depth is at most one.
 */
export class SingleFlight<T> {
  private inflight: Promise<T> | null = null;
  private followUp: Promise<T> | null = null;
  private starts = 0;

  constructor(private readonly fn: () => Promise<T>) {}

  /** Number of times `fn` has actually started. For tests and diagnostics. */
  get runs(): number {
    return this.starts;
  }

  get busy(): boolean {
    return this.inflight !== null;
  }

  poll(): Promise<T> {
    return this.inflight ?? this.start();
  }

  request(): Promise<T> {
    if (this.inflight === null) return this.start();
    if (this.followUp === null) {
      const current = this.inflight;
      this.followUp = current
        .catch(() => undefined)
        .then(() => {
          this.followUp = null;
          return this.start();
        });
    }
    return this.followUp;
  }

  private start(): Promise<T> {
    this.starts += 1;
    const p = this.fn().finally(() => {
      if (this.inflight === p) this.inflight = null;
    });
    this.inflight = p;
    return p;
  }
}
