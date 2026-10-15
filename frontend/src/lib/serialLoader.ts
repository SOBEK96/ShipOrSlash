/**
 * SerialLoader: loads many keyed items one at a time and never lets one bad
 * read erase the others.
 *
 *  - Serial. Items load strictly one after another, so a page that needs a
 *    vault, three milestones and the verifier sources does not fire a burst of
 *    concurrent gen_call requests at a public RPC.
 *  - Per-item failure retention. If a read fails, that item keeps its last good
 *    value and gains an error; every other item is untouched. A partial failure
 *    is therefore visible (see `failedKeys`) instead of silently blanking a
 *    panel or, worse, rendering a default as if it were data.
 *  - Monotone clock. Every load takes a strictly increasing ticket before it
 *    starts. A result is applied only if its ticket is newer than what the item
 *    already holds, so a slow old response can never overwrite a newer one.
 *  - Generations. `reset()` (an account switch, a network switch) bumps the
 *    generation and clears everything; a response that was in flight across the
 *    reset is dropped on arrival.
 */

export class MonotoneClock {
  private last = 0;
  constructor(private readonly source: () => number = () => Date.now()) {}

  /** Strictly increasing, even if the wall clock stalls or steps backwards. */
  now(): number {
    const t = this.source();
    this.last = t > this.last ? t : this.last + 1;
    return this.last;
  }
}

export interface LoadEntry<V> {
  value: V | undefined;
  /** Message of the most recent failure, or null when the latest load succeeded. */
  error: string | null;
  /** Ticket of the load that produced `value`. 0 when never loaded. */
  loadedAt: number;
  /** Ticket of the latest failed load. 0 when none has failed. */
  failedAt: number;
  /** Total load attempts for this key in the current generation. */
  attempts: number;
}

export class SerialLoader<K extends string, V> {
  private entries = new Map<K, LoadEntry<V>>();
  private tail: Promise<void> = Promise.resolve();
  private gen = 0;
  private readonly clock: MonotoneClock;
  private listeners = new Set<() => void>();

  constructor(
    private readonly loadOne: (key: K) => Promise<V>,
    clock: MonotoneClock = new MonotoneClock(),
  ) {
    this.clock = clock;
  }

  get generation(): number {
    return this.gen;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Queue `keys` behind everything already queued; resolves when they are done. */
  load(keys: readonly K[]): Promise<void> {
    const gen = this.gen;
    const run = this.tail.then(async () => {
      for (const key of keys) {
        if (gen !== this.gen) return; // reset while queued: drop the rest
        await this.loadKey(key, gen);
      }
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async loadKey(key: K, gen: number): Promise<void> {
    const ticket = this.clock.now();
    const prev = this.entries.get(key);
    this.entries.set(key, {
      value: prev?.value,
      error: prev?.error ?? null,
      loadedAt: prev?.loadedAt ?? 0,
      failedAt: prev?.failedAt ?? 0,
      attempts: (prev?.attempts ?? 0) + 1,
    });
    try {
      const value = await this.loadOne(key);
      if (gen !== this.gen) return;
      const cur = this.entries.get(key);
      if (cur && cur.loadedAt > ticket) return; // a newer load already landed
      this.entries.set(key, {
        value,
        error: null,
        loadedAt: ticket,
        failedAt: cur?.failedAt ?? 0,
        attempts: cur?.attempts ?? 1,
      });
    } catch (e) {
      if (gen !== this.gen) return;
      const cur = this.entries.get(key);
      this.entries.set(key, {
        value: cur?.value, // retention: keep the last good value
        error: e instanceof Error ? e.message : String(e),
        loadedAt: cur?.loadedAt ?? 0,
        failedAt: Math.max(cur?.failedAt ?? 0, ticket),
        attempts: cur?.attempts ?? 1,
      });
    }
    this.emit();
  }

  get(key: K): LoadEntry<V> | undefined {
    return this.entries.get(key);
  }

  value(key: K): V | undefined {
    return this.entries.get(key)?.value;
  }

  /** Keys whose most recent load failed. */
  failedKeys(): K[] {
    const out: K[] = [];
    for (const [k, e] of this.entries) if (e.error !== null) out.push(k);
    return out;
  }

  /** Keys that failed but still hold a previous value (stale, not blank). */
  staleKeys(): K[] {
    const out: K[] = [];
    for (const [k, e] of this.entries) if (e.error !== null && e.value !== undefined) out.push(k);
    return out;
  }

  snapshot(): ReadonlyMap<K, LoadEntry<V>> {
    return new Map(this.entries);
  }

  /** Forget everything and invalidate in-flight loads. */
  reset(): void {
    this.gen += 1;
    this.entries = new Map();
    this.emit();
  }
}
