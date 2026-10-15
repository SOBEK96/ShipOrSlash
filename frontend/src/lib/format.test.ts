import { describe, expect, it } from "vitest";
import { formatBps, formatDuration, formatGen, formatUtc, isAddress, parseGen, sameAddress, shortHash } from "./format";

describe("formatGen", () => {
  it.each([
    [0n, "0"],
    [10n ** 18n, "1"],
    [5n * 10n ** 17n, "0.5"],
    [1n, "0"],
    [10n ** 15n, "0.001"],
    [123_456_789_012_345_678n, "0.123456"],
    [3n * 10n ** 18n + 5n * 10n ** 17n, "3.5"],
    [-5n * 10n ** 17n, "-0.5"],
  ])("%s wei -> %s", (wei, want) => {
    expect(formatGen(wei)).toBe(want);
  });
});

describe("parseGen", () => {
  it.each([
    ["0.5", 5n * 10n ** 17n],
    ["1", 10n ** 18n],
    ["0.001", 10n ** 15n],
    ["12.000000000000000001", 12n * 10n ** 18n + 1n],
    [" 2 ", 2n * 10n ** 18n],
  ])("parses %j", (s, want) => {
    expect(parseGen(s)).toBe(want);
  });

  it.each(["", "abc", "-1", "1e3", "1.2.3", "0.0000000000000000001", ".5", "1,5", "0x10", "1."])(
    "rejects %j",
    (s) => {
      expect(parseGen(s)).toBeNull();
    },
  );

  it("round-trips", () => {
    for (const w of [1n, 10n ** 15n, 123n, 10n ** 18n + 7n]) {
      expect(parseGen(formatGen(w, 18))).toBe(w);
    }
  });
});

describe("misc formatting", () => {
  it.each([
    [2000, "20%"],
    [3000, "30%"],
    [5000, "50%"],
    [10000, "100%"],
    [1250, "12.5%"],
    [1205, "12.05%"],
    [0, "0%"],
  ])("formatBps(%i) = %s", (bps, want) => {
    expect(formatBps(bps)).toBe(want);
  });

  it("shortHash keeps head and tail", () => {
    expect(shortHash("0x059c675971F5c095BD9aa4B7C942DF7287BbcDc6", 8, 6)).toBe("0x059c67…BbcDc6");
    expect(shortHash("abc")).toBe("abc");
  });

  it("formatUtc is locale free", () => {
    expect(formatUtc(1760000000)).toBe("2025-10-09 08:53 UTC");
    expect(formatUtc(0)).toBe("—");
    expect(formatUtc(Number.NaN)).toBe("—");
  });

  it.each([
    [0, "0s"],
    [45, "45s"],
    [120, "2m"],
    [3 * 3600 + 5 * 60, "3h 5m"],
    [2 * 86400 + 5 * 3600, "2d 5h"],
  ])("formatDuration(%i) = %s", (s, want) => {
    expect(formatDuration(s)).toBe(want);
  });

  it("compares addresses case-insensitively", () => {
    expect(sameAddress("0xABC", "0xabc")).toBe(true);
    expect(sameAddress("0xabc", "0xabd")).toBe(false);
    expect(sameAddress(null, "0xabc")).toBe(false);
  });

  it.each([
    ["0x02988d77da89002ef09b168b404e19de3da4edcc", true],
    ["0x0000000000000000000000000000000000000000", false],
    ["0x123", false],
    ["02988d77da89002ef09b168b404e19de3da4edcc", false],
    ["0xZZ988d77da89002ef09b168b404e19de3da4edcc", false],
  ])("isAddress(%j) = %s", (a, want) => {
    expect(isAddress(a)).toBe(want);
  });
});
