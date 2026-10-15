import { describe, expect, it } from "vitest";
import { SingleFlight } from "./coalesce";

function gate() {
  let open!: () => void;
  let fail!: (e: unknown) => void;
  const p = new Promise<void>((res, rej) => {
    open = res;
    fail = rej;
  });
  return { p, open, fail };
}

describe("SingleFlight", () => {
  it("runs once for any number of polls while a read is in flight", async () => {
    const g = gate();
    const f = new SingleFlight(() => g.p);
    const a = f.poll();
    const b = f.poll();
    const c = f.poll();
    expect(f.runs).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    g.open();
    await a;
    expect(f.runs).toBe(1);
  });

  it("a slow read (longer than many poll intervals) is never restarted or invalidated", async () => {
    const g = gate();
    let completed = 0;
    const f = new SingleFlight(async () => {
      await g.p;
      completed++;
    });
    const first = f.poll();
    for (let i = 0; i < 25; i++) void f.poll(); // 25 ticks while the RPC stalls
    expect(f.runs).toBe(1);
    g.open();
    await first;
    expect(completed).toBe(1);
  });

  it("request() during a read queues exactly one follow-up, however many arrive", async () => {
    const gates = [gate(), gate()];
    let n = 0;
    const f = new SingleFlight(async () => gates[n++]!.p);
    const first = f.poll();
    const r1 = f.request();
    const r2 = f.request();
    const r3 = f.request();
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
    expect(f.runs).toBe(1);
    gates[0]!.open();
    await first;
    await Promise.resolve();
    await Promise.resolve();
    expect(f.runs).toBe(2);
    gates[1]!.open();
    await r1;
    expect(f.runs).toBe(2);
  });

  it("poll() never queues a follow-up", async () => {
    const g = gate();
    const f = new SingleFlight(() => g.p);
    const p = f.poll();
    f.poll();
    f.poll();
    g.open();
    await p;
    await Promise.resolve();
    expect(f.runs).toBe(1);
  });

  it("starts a fresh run once the previous one has settled", async () => {
    let n = 0;
    const f = new SingleFlight(async () => ++n);
    expect(await f.poll()).toBe(1);
    expect(await f.poll()).toBe(2);
    expect(await f.request()).toBe(3);
  });

  it("a failed read does not wedge the flight, and the follow-up still runs", async () => {
    const g = gate();
    let n = 0;
    const f = new SingleFlight(async () => {
      n++;
      if (n === 1) await g.p;
      return n;
    });
    const first = f.poll();
    const follow = f.request();
    g.fail(new Error("rpc down"));
    await expect(first).rejects.toThrow("rpc down");
    expect(await follow).toBe(2);
    expect(f.busy).toBe(false);
  });

  it("reports busy only while a read is in flight", async () => {
    const g = gate();
    const f = new SingleFlight(() => g.p);
    expect(f.busy).toBe(false);
    const p = f.poll();
    expect(f.busy).toBe(true);
    g.open();
    await p;
    expect(f.busy).toBe(false);
  });
});
