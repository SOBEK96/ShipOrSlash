import { describe, expect, it } from "vitest";
import {
  assessFeeds,
  canonHash,
  checkTag,
  compareSemver,
  cumEntitlement,
  feedHost,
  fingerprintHash,
  normalizeRepo,
  operatorOf,
  parseSemver,
  quorumOutlook,
  semverFitsMilestone,
  trancheAmounts,
  validArtifactTarget,
  type SourceState,
} from "./protocol";

describe("tranche arithmetic", () => {
  it.each([
    [1_000_000_000_000_000n],
    [1_000_000_000_000_001n],
    [1_000_000_000_000_003n],
    [123_456_789_012_345_678n],
    [10n ** 18n],
    [700_000_000_000_000_001n],
    [999_999_999_999_999_999n],
    [3n * 10n ** 18n + 7n],
    [10n ** 21n + 13n],
    [2n ** 64n + 1n],
  ])("amounts for %s sum to the deposit exactly", (d) => {
    const [a, b, c] = trancheAmounts(d);
    expect(a + b + c).toBe(d);
    expect(a).toBe((d * 2000n) / 10000n);
    expect(a + b).toBe((d * 5000n) / 10000n);
    expect(c >= d / 2n).toBe(true);
    expect(a > 0n && b > 0n && c > 0n).toBe(true);
  });

  it("is cumulative and monotone", () => {
    const d = 10n ** 18n + 17n;
    expect(cumEntitlement(d, 0)).toBe(0n);
    expect(cumEntitlement(d, 1) <= cumEntitlement(d, 2)).toBe(true);
    expect(cumEntitlement(d, 3)).toBe(d);
  });

  it("is exact at 0.5 GEN", () => {
    expect(trancheAmounts(5n * 10n ** 17n)).toEqual([10n ** 17n, 15n * 10n ** 16n, 25n * 10n ** 16n]);
  });
});

describe("SemVer", () => {
  it.each([
    ["v0.1.0-alpha.1", "v"],
    ["v1.2.3", "v"],
    ["1.2.3", ""],
    ["v10.20.30-rc.1", "v"],
    ["v0.0.1-alpha.0", "v"],
    ["v1.0.0-x.7.z.92", "v"],
  ] as const)("parses %s", (tag, prefix) => {
    expect(parseSemver(tag, prefix)).not.toBeNull();
  });

  it.each([
    ["v1.0", "v"],
    ["v01.0.0", "v"],
    ["1.2.3", "v"],
    ["v1.2.3", ""],
    ["vv1.2.3", "v"],
    ["v1.2.3+build", "v"],
    ["v1.2.3-", "v"],
    ["v1.2.3-a..b", "v"],
    ["v1.2.3-01", "v"],
    ["v1.2.3-a_b", "v"],
    ["", "v"],
    ["V1.2.3", "v"],
    ["v1.2.x", "v"],
    ["v1234567890.0.0", "v"],
    ["v-1.0.0", "v"],
  ] as const)("rejects %j", (tag, prefix) => {
    expect(parseSemver(tag, prefix)).toBeNull();
  });

  const p = (s: string) => parseSemver(s, "v")!;
  it.each([
    ["v1.0.0", "v1.0.0-rc.1", 1],
    ["v1.0.0-rc.1", "v1.0.0-beta.1", 1],
    ["v1.0.0-beta.1", "v1.0.0-alpha.1", 1],
    ["v1.0.0-alpha.2", "v1.0.0-alpha.1", 1],
    ["v1.0.0-alpha.10", "v1.0.0-alpha.9", 1],
    ["v1.0.0-alpha", "v1.0.0-alpha.1", -1],
    ["v0.9.0", "v1.0.0", -1],
    ["v1.0.0", "v1.0.0", 0],
    ["v1.0.0-1", "v1.0.0-a", -1],
    ["v2.0.0", "v1.99.99", 1],
  ] as const)("compares %s to %s -> %i", (a, b, want) => {
    expect(compareSemver(p(a), p(b))).toBe(want);
  });

  it.each([
    ["v0.1.0-alpha.1", 1, true],
    ["v0.1.0-beta", 1, true],
    ["v0.1.0", 1, false],
    ["v0.1.0-rc.1", 1, false],
    ["v0.9.0-rc.1", 2, true],
    ["v0.9.0-alpha.1", 2, false],
    ["v0.9.0", 2, false],
    ["v1.0.0", 3, true],
    ["v0.9.9", 3, false],
    ["v1.0.0-rc.1", 3, false],
  ] as const)("%s fits tranche %i: %s", (tag, m, want) => {
    expect(semverFitsMilestone(p(tag), m)).toBe(want);
  });

  it("checkTag explains each failure", () => {
    expect(checkTag("nope", 1, "v").reason).toMatch(/SemVer/);
    expect(checkTag("v0.1.0", 1, "v").reason).toMatch(/alpha/);
    expect(checkTag("v0.1.0-rc.1", 2, "v", "v0.5.0-alpha.1").ok).toBe(false);
    expect(checkTag("v0.1.0-rc.1", 2, "v", "v0.1.0-alpha.1").ok).toBe(true);
    expect(checkTag("v1.0.0", 3, "v", "v1.0.0-rc.1").ok).toBe(true);
    expect(checkTag("v0.9.0", 3, "v").reason).toMatch(/1\.0\.0/);
  });
});

describe("repository registry", () => {
  it.each([
    ["https://github.com/SOBEK96/ShipOrSlash", "https://github.com/sobek96/shiporslash"],
    ["https://github.com/SOBEK96/ShipOrSlash.git", "https://github.com/sobek96/shiporslash"],
    ["https://github.com/SOBEK96/ShipOrSlash/", "https://github.com/sobek96/shiporslash"],
    ["https://gitlab.com/group/proj", "https://gitlab.com/group/proj"],
    ["HTTPS://GITHUB.COM/Owner/Repo", "https://github.com/owner/repo"],
  ])("normalizes %s", (input, want) => {
    expect(normalizeRepo(input)).toBe(want);
  });

  it.each([
    "http://github.com/a/b",
    "https://github.com/a",
    "https://github.com/a/b/c",
    "https://bitbucket.org/a/b",
    "https://github.com.evil.com/a/b",
    "https://github.com:8080/a/b",
    "https://user@github.com/a/b",
    "https://github.com/a/b?x=1",
    "https://github.com/a/b#x",
    "https://github.com/../b",
    "",
    "github.com/a/b",
    "https://github.com//b",
    "ftp://github.com/a/b",
  ])("rejects %j", (input) => {
    expect(normalizeRepo(input)).toBe("");
  });

  it("canonicalises signer digests", () => {
    const h = "d8a87fdcd4224662af9b788cae845191b3bc64b8155eb124fdbe0d506e4fcf10";
    expect(canonHash(h)).toBe(h);
    expect(canonHash(h.toUpperCase())).toBe(h);
    expect(canonHash(`0x${h}`)).toBe(h);
    expect(canonHash(`  ${h}  `)).toBe(h);
    expect(canonHash(h.slice(1))).toBe("");
    expect(canonHash(`${h}0`)).toBe("");
    expect(canonHash("g".repeat(64))).toBe("");
    expect(canonHash("")).toBe("");
  });

  it("hashes the demo fingerprint to the digest the fixtures commit", async () => {
    const h = await fingerprintHash("3AA5 C34371567BD2 5FA4E14A9D8C1B7E00F26A41");
    expect(h).toBe("d8a87fdcd4224662af9b788cae845191b3bc64b8155eb124fdbe0d506e4fcf10");
    // whitespace and case do not change the commitment
    expect(await fingerprintHash("3aa5c34371567bd25fa4e14a9d8c1b7e00f26a41")).toBe(h);
  });

  it.each([
    ["@sobek96/shiporslash", true],
    ["sobek96/shiporslash", true],
    ["", true],
    ["bad name", false],
    ['a"b', false],
    ["a\\b", false],
    ["<x>", false],
    ["x".repeat(101), false],
    ["café", false],
  ])("artifact target %j -> %s", (name, ok) => {
    expect(validArtifactTarget(name)).toBe(ok);
  });
});

describe("verifier feeds", () => {
  it.each([
    ["https://raw.githubusercontent.com/o/r/", "raw.githubusercontent.com"],
    ["https://cdn.jsdelivr.net/gh/o/r@sha/", "cdn.jsdelivr.net"],
    ["https://RAW.GITHACK.COM/o/r/", "raw.githack.com"],
  ])("accepts %s", (url, host) => {
    expect(feedHost(url)).toBe(host);
  });

  it.each([
    "http://raw.githubusercontent.com/x/",
    "https://127.0.0.1/x/",
    "https://localhost/x/",
    "https://10.0.0.5/x/",
    "https://user:pw@raw.githubusercontent.com/x/",
    "https://raw.githubusercontent.com:8443/x/",
    "https://raw.githubusercontent.com/x/?a=1",
    "https://raw.githubusercontent.com/x/#f",
    "https://raw.githubusercontent.com/x",
    "ftp://raw.githubusercontent.com/x/",
    "",
    "https://metadata.internal/x/",
    "https://printer.local/x/",
    "https://2130706433/x/",
    "https://169.254.169.254/latest/",
  ])("rejects %j", (url) => {
    expect(feedHost(url)).toBe("");
  });

  it.each([
    ["raw.githubusercontent.com", "github"],
    ["api.github.com", "github"],
    ["cdn.jsdelivr.net", "jsdelivr"],
    ["fastly.jsdelivr.net", "jsdelivr"],
    ["raw.githack.com", "githack"],
    ["registry.npmjs.org", "npm"],
    ["a.example.org", "example.org"],
  ])("operator of %s is %s", (host, op) => {
    expect(operatorOf(host)).toBe(op);
  });

  it("accepts the three default mirrors as independent", () => {
    const r = assessFeeds([
      "https://raw.githubusercontent.com/o/r/",
      "https://cdn.jsdelivr.net/gh/o/r/",
      "https://raw.githack.com/o/r/",
    ]);
    expect(r.independent).toBe(true);
    expect(r.operators).toEqual(["github", "jsdelivr", "githack"]);
  });

  it("rejects duplicate hosts", () => {
    const r = assessFeeds([
      "https://raw.githubusercontent.com/a/",
      "https://raw.githubusercontent.com/b/",
      "https://cdn.jsdelivr.net/c/",
    ]);
    expect(r.independent).toBe(false);
    expect(r.problems[0]).toMatch(/distinct hostnames/);
  });

  it("rejects distinct hosts run by one operator", () => {
    const r = assessFeeds([
      "https://raw.githubusercontent.com/a/",
      "https://api.github.com/b/",
      "https://cdn.jsdelivr.net/c/",
    ]);
    expect(r.independent).toBe(false);
    expect(r.problems[0]).toMatch(/distinct operators/);
  });

  it("names the slot with an unsafe URL", () => {
    const r = assessFeeds(["https://raw.githubusercontent.com/a/", "http://x/", "https://raw.githack.com/c/"]);
    expect(r.problems.join(" ")).toMatch(/Slot B/);
  });
});

describe("quorum outlook (all 64 source-state combinations)", () => {
  // Independent oracle, written from the specification.
  function oracle(s: SourceState[]): 0 | 1 | 2 {
    const c = s.filter((x) => x === "CONFIRMED").length;
    const f = s.filter((x) => x === "FAILED" || x === "NOT_FOUND").length;
    const o = s.filter((x) => x === "OUTAGE").length;
    if (c + f < 2) return 2;
    if (c >= 2) return 1;
    if (f >= 2) return 0;
    return o >= 1 && (c + o >= 2 || f + o >= 2) ? 2 : 0;
  }
  const all: SourceState[] = ["CONFIRMED", "FAILED", "NOT_FOUND", "OUTAGE"];
  const combos: SourceState[][] = [];
  for (const a of all) for (const b of all) for (const c of all) combos.push([a, b, c]);

  it.each(combos)("%s / %s / %s", (a, b, c) => {
    expect(quorumOutlook([a, b, c])).toBe(oracle([a, b, c]));
  });

  it("matches the specification's headline case", () => {
    expect(quorumOutlook(["CONFIRMED", "NOT_FOUND", "OUTAGE"])).toBe(2);
  });
});
