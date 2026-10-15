import { describe, expect, it } from "vitest";
import { MAX_WINDOW_S, MIN_WINDOW_S } from "./protocol";
import { DEADLINE_SKEW_BUFFER_S, computeDeadline, fetchChainTime } from "./deadline";

const T = 1_800_000_000;

/** The contract's rule for a deadline, for a block executing at `blockNow`. */
const accepted = (deadline: number, blockNow: number) =>
  deadline >= blockNow + MIN_WINDOW_S && deadline <= blockNow + MAX_WINDOW_S;

describe("computeDeadline", () => {
  it("adds the buffer on the near side", () => {
    expect(computeDeadline({ days: 1, clientNow: T, chainNow: T })).toBe(T + 86_400 + DEADLINE_SKEW_BUFFER_S);
    expect(computeDeadline({ days: 30, clientNow: T, chainNow: T })).toBe(T + 30 * 86_400 + 3_600);
  });

  it("uses the later of the client and chain clocks", () => {
    expect(computeDeadline({ days: 1, clientNow: T, chainNow: T + 500 })).toBe(T + 500 + 86_400 + 3_600);
    expect(computeDeadline({ days: 1, clientNow: T + 500, chainNow: T })).toBe(T + 500 + 86_400 + 3_600);
  });

  it("falls back to the client clock when the chain's cannot be read", () => {
    expect(computeDeadline({ days: 1, clientNow: T, chainNow: null })).toBe(T + 86_400 + 3_600);
  });

  it("honours a configured buffer, including none", () => {
    expect(computeDeadline({ days: 1, clientNow: T, chainNow: T, bufferS: 0 })).toBe(T + 86_400);
    expect(computeDeadline({ days: 1, clientNow: T, chainNow: T, bufferS: 7_200 })).toBe(T + 86_400 + 7_200);
    expect(computeDeadline({ days: 1, clientNow: T, chainNow: T, bufferS: -50 })).toBe(T + 86_400);
  });

  it("never exceeds the five-year ceiling, even with the buffer", () => {
    const d = computeDeadline({ days: 1825, clientNow: T, chainNow: T });
    expect(d).toBe(T + MAX_WINDOW_S);
    expect(accepted(d, T)).toBe(true);
    expect(accepted(d, T + 3_000)).toBe(true); // a later block only moves the ceiling out
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects days = %s", (days) => {
    expect(() => computeDeadline({ days, clientNow: T, chainNow: T })).toThrow(RangeError);
  });

  describe("clock-skew regression: a one-day vault that the contract will accept", () => {
    // How late the executing block is relative to the clock the deadline was
    // taken from: network latency, consensus queueing, and clock drift.
    it.each([0, 1, 5, 30, 120, 600, 1_800, 3_000, 3_600])("lands %is late", (late) => {
      const d = computeDeadline({ days: 1, clientNow: T, chainNow: T });
      expect(accepted(d, T + late)).toBe(true);
    });

    it("without the buffer the same vault is rejected after even one second", () => {
      const bare = computeDeadline({ days: 1, clientNow: T, chainNow: T, bufferS: 0 });
      expect(accepted(bare, T)).toBe(true);
      expect(accepted(bare, T + 1)).toBe(false);
    });

    it("a client clock running 10 minutes behind the chain is still safe", () => {
      const chain = T + 600;
      const d = computeDeadline({ days: 1, clientNow: T, chainNow: chain });
      expect(accepted(d, chain + 120)).toBe(true);
    });

    it("the buffer is a bound: a block more than an hour late is still rejected", () => {
      const d = computeDeadline({ days: 1, clientNow: T, chainNow: T });
      expect(accepted(d, T + 3_601)).toBe(false);
    });
  });
});

describe("fetchChainTime", () => {
  const reply = (body: unknown, ok = true) => async () => ({ ok, json: async () => body });

  it("reads the latest block timestamp", async () => {
    const t = await fetchChainTime("https://rpc", reply({ result: { timestamp: "0x6ad142cf" } }));
    expect(t).toBe(0x6ad142cf);
  });

  it.each([
    ["an HTTP error", reply({}, false)],
    ["no result", reply({ result: null })],
    ["no timestamp", reply({ result: {} })],
    ["a non-hex timestamp", reply({ result: { timestamp: "1792099023" } })],
    ["a zero timestamp", reply({ result: { timestamp: "0x0" } })],
    ["an unsafe timestamp", reply({ result: { timestamp: "0xffffffffffffffffff" } })],
    ["a thrown fetch", async () => {
      throw new TypeError("Failed to fetch");
    }],
  ])("returns null for %s", async (_n, fetcher) => {
    expect(await fetchChainTime("https://rpc", fetcher as never)).toBeNull();
  });

  it("posts eth_getBlockByNumber", async () => {
    let seen: { body?: string } = {};
    await fetchChainTime("https://rpc", async (_u, init) => {
      seen = init;
      return { ok: true, json: async () => ({ result: { timestamp: "0x10" } }) };
    });
    expect(JSON.parse(seen.body!)).toMatchObject({ method: "eth_getBlockByNumber", params: ["latest", false] });
  });
});
