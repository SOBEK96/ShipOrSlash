import { describe, expect, it } from "vitest";
import { MonotoneClock, SerialLoader } from "./serialLoader";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("MonotoneClock", () => {
  it("is strictly increasing when the wall clock stalls", () => {
    const c = new MonotoneClock(() => 100);
    const a = c.now();
    const b = c.now();
    const d = c.now();
    expect(a < b && b < d).toBe(true);
  });

  it("never goes backwards when the wall clock steps back", () => {
    let t = 1000;
    const c = new MonotoneClock(() => t);
    const a = c.now();
    t = 10;
    expect(c.now()).toBeGreaterThan(a);
  });

  it("follows the wall clock when it moves forward", () => {
    let t = 5;
    const c = new MonotoneClock(() => t);
    c.now();
    t = 5000;
    expect(c.now()).toBe(5000);
  });
});

describe("SerialLoader", () => {
  it("loads keys strictly one at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    const l = new SerialLoader<string, number>(async (k) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight--;
      return k.length;
    });
    await l.load(["a", "bb", "ccc", "dddd"]);
    expect(peak).toBe(1);
    expect(l.value("ccc")).toBe(3);
  });

  it("keeps the last good value when a later read of that item fails", async () => {
    let fail = false;
    const l = new SerialLoader<string, string>(async (k) => {
      if (fail && k === "m2") throw new Error("RPC timeout");
      return `${k}:ok`;
    });
    await l.load(["vault", "m2"]);
    fail = true;
    await l.load(["vault", "m2"]);
    expect(l.value("m2")).toBe("m2:ok");
    expect(l.get("m2")?.error).toBe("RPC timeout");
    expect(l.get("vault")?.error).toBeNull();
    expect(l.failedKeys()).toEqual(["m2"]);
    expect(l.staleKeys()).toEqual(["m2"]);
  });

  it("a failure never touches other items", async () => {
    const l = new SerialLoader<string, number>(async (k) => {
      if (k === "bad") throw new Error("boom");
      return 1;
    });
    await l.load(["a", "bad", "b"]);
    expect(l.value("a")).toBe(1);
    expect(l.value("b")).toBe(1);
    expect(l.value("bad")).toBeUndefined();
    expect(l.failedKeys()).toEqual(["bad"]);
    expect(l.staleKeys()).toEqual([]); // failed with nothing to retain
  });

  it("clears the error once the item loads again", async () => {
    let n = 0;
    const l = new SerialLoader<string, number>(async () => {
      n++;
      if (n === 1) throw new Error("first");
      return n;
    });
    await l.load(["x"]);
    expect(l.get("x")?.error).toBe("first");
    await l.load(["x"]);
    expect(l.get("x")?.error).toBeNull();
    expect(l.value("x")).toBe(2);
  });

  it("counts attempts per key", async () => {
    const l = new SerialLoader<string, number>(async () => 1);
    await l.load(["x"]);
    await l.load(["x"]);
    await l.load(["x"]);
    expect(l.get("x")?.attempts).toBe(3);
  });

  it("never starts a queued load that is reset before it begins", async () => {
    const seen: string[] = [];
    const l = new SerialLoader<string, number>(async (k) => {
      seen.push(k);
      return 1;
    });
    const p = l.load(["a"]);
    l.reset();
    await p;
    expect(seen).toEqual([]);
  });

  it("drops a response that was in flight across reset()", async () => {
    const d = deferred<string>();
    const l = new SerialLoader<string, string>(() => d.promise);
    const p = l.load(["x"]);
    l.reset();
    d.resolve("stale");
    await p;
    expect(l.value("x")).toBeUndefined();
    expect(l.generation).toBe(1);
  });

  it("drops queued keys once reset() has been called", async () => {
    const first = deferred<number>();
    const seen: string[] = [];
    const l = new SerialLoader<string, number>(async (k) => {
      seen.push(k);
      if (k === "a") return first.promise;
      return 2;
    });
    const p = l.load(["a", "b", "c"]);
    await new Promise((r) => setTimeout(r, 0)); // let "a" start and block
    expect(seen).toEqual(["a"]);
    l.reset();
    first.resolve(1);
    await p;
    expect(seen).toEqual(["a"]); // "b" and "c" never started
    expect(l.snapshot().size).toBe(0);
  });

  it("serialises separate load() calls behind each other", async () => {
    const order: string[] = [];
    const l = new SerialLoader<string, number>(async (k) => {
      order.push(`start ${k}`);
      await Promise.resolve();
      order.push(`end ${k}`);
      return 1;
    });
    await Promise.all([l.load(["a"]), l.load(["b"])]);
    expect(order).toEqual(["start a", "end a", "start b", "end b"]);
  });

  it("notifies subscribers and supports unsubscribe", async () => {
    const l = new SerialLoader<string, number>(async () => 1);
    let n = 0;
    const off = l.subscribe(() => n++);
    await l.load(["a", "b"]);
    expect(n).toBe(2);
    off();
    await l.load(["c"]);
    expect(n).toBe(2);
  });

  it("assigns later loads strictly later tickets", async () => {
    const l = new SerialLoader<string, number>(async () => 1, new MonotoneClock(() => 1));
    await l.load(["x"]);
    const t1 = l.get("x")!.loadedAt;
    await l.load(["x"]);
    expect(l.get("x")!.loadedAt).toBeGreaterThan(t1);
  });
});
