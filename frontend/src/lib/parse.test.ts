import { describe, expect, it } from "vitest";
import {
  ParseError,
  parseClaimResult,
  parseMilestoneStatus,
  parseProtocolState,
  parseVaultState,
  parseVerifierSources,
  toPlain,
} from "./parse";

const tranche = (id: number, over: Record<string, unknown> = {}) => ({
  milestone_id: id,
  kind: ["ALPHA", "RC", "STABLE"][id - 1],
  bps: [2000, 3000, 5000][id - 1],
  status: id === 1 ? "PENDING" : "LOCKED",
  release_tag: "",
  commit_sha: "",
  artifact_digest: "",
  verified_ts: 0,
  amount: ["100000000000000000", "150000000000000000", "250000000000000000"][id - 1],
  ...over,
});

const vault = (over: Record<string, unknown> = {}) => ({
  vault_id: 1,
  status: "ACTIVE",
  funder: "0x2bd806c97f0e00af1a1fc3328fa763a9269723c8",
  beneficiary: "0x81b637d8fcd2c6da6359e6963113a1170de795e4",
  repo_url: "https://github.com/sobek96/shiporslash",
  signer_hash: "d8a87fdcd4224662af9b788cae845191b3bc64b8155eb124fdbe0d506e4fcf10",
  tag_prefix: "v",
  npm_package: "@sobek96/shiporslash",
  docker_image: "sobek96/shiporslash",
  feeds: ["https://a.example.org/", "https://b.example.net/", "https://c.example.io/"],
  deadline: 1_794_682_476,
  created_at: 1_792_090_476,
  accept_deadline: 1_792_263_276,
  accepted_at: 0,
  deposited: "500000000000000000",
  released: "0",
  withdrawn: "0",
  reclaimed: "0",
  withdrawable: "0",
  unreleased: "500000000000000000",
  tranches_done: 0,
  attempts: 0,
  last_verdict: 0,
  last_source_count: 0,
  last_attempt_at: 0,
  last_milestone: 0,
  tranches: [tranche(1), tranche(2), tranche(3)],
  ...over,
});

describe("toPlain", () => {
  it("converts Maps and bigints", () => {
    const m = new Map<string, unknown>([
      ["a", 5n],
      ["b", new Map([["c", "x"]])],
      ["d", [1n, 2n]],
    ]);
    expect(toPlain(m)).toEqual({ a: 5, b: { c: "x" }, d: [1, 2] });
  });

  it("keeps bigints beyond the safe integer range as decimal strings", () => {
    expect(toPlain(2n ** 70n)).toBe((2n ** 70n).toString());
  });

  it("refuses a float, because the contract never sends one", () => {
    expect(() => toPlain({ x: 1.5 })).toThrow(ParseError);
  });

  it("encodes bytes as hex", () => {
    expect(toPlain(new Uint8Array([1, 255]))).toBe("0x01ff");
  });

  it("maps null and undefined to null", () => {
    expect(toPlain(undefined)).toBeNull();
    expect(toPlain(null)).toBeNull();
  });
});

describe("parseVaultState", () => {
  it("parses a fresh vault, accepting a Map-shaped response", () => {
    const asMap = new Map<string, unknown>(Object.entries(vault()).map(([k, v]) => [k, v]));
    const v = parseVaultState(asMap);
    expect(v.deposited).toBe(500_000_000_000_000_000n);
    expect(v.tranches.map((t) => t.status)).toEqual(["PENDING", "LOCKED", "LOCKED"]);
    expect(v.tagPrefix).toBe("v");
  });

  it.each(["PENDING_ACCEPTANCE", "ACTIVE", "COMPLETE", "SLASHED", "REJECTED", "CANCELLED"])("accepts vault status %s", (status) => {
    expect(parseVaultState(vault({ status })).status).toBe(status);
  });

  it("reads the acceptance window", () => {
    const v = parseVaultState(vault({ status: "PENDING_ACCEPTANCE", accepted_at: 0 }));
    expect(v.acceptDeadline).toBe(1_792_263_276);
    expect(v.acceptedAt).toBe(0);
  });

  it("accepts the CANCELLED tranche status of a rejected or cancelled vault", () => {
    const t = (id: number) => tranche(id, { status: "CANCELLED" });
    expect(parseVaultState(vault({ status: "CANCELLED", tranches: [t(1), t(2), t(3)] })).tranches[0].status).toBe("CANCELLED");
  });

  it.each(["accept_deadline", "accepted_at"])("rejects a vault view missing %s", (k) => {
    expect(() => parseVaultState(vault({ [k]: undefined }))).toThrow(ParseError);
  });

  it("parses plain objects too", () => {
    expect(parseVaultState(vault()).vaultId).toBe(1);
  });

  it.each([
    ["status", { status: "WEIRD" }],
    ["tag prefix", { tag_prefix: "x" }],
    ["tranches_done range", { tranches_done: 4 }],
    ["released > deposited", { released: "600000000000000000" }],
    ["feeds length", { feeds: ["a"] }],
    ["feeds type", { feeds: [1, 2, 3] }],
    ["tranche count", { tranches: [tranche(1)] }],
    ["tranche order", { tranches: [tranche(2), tranche(1), tranche(3)] }],
    ["tranche status", { tranches: [tranche(1, { status: "?" }), tranche(2), tranche(3)] }],
    ["negative amount", { deposited: "-5" }],
    ["amount type", { deposited: true }],
    ["missing field", { deadline: undefined }],
  ])("rejects a malformed vault: %s", (_n, over) => {
    expect(() => parseVaultState(vault(over))).toThrow(ParseError);
  });

  it("rejects non-objects", () => {
    expect(() => parseVaultState(null)).toThrow(ParseError);
    expect(() => parseVaultState([])).toThrow(ParseError);
    expect(() => parseVaultState("x")).toThrow(ParseError);
  });
});

describe("parseVerifierSources", () => {
  const src = (slot: string) => ({
    slot,
    role: "role",
    base_url: "https://x.example.org/",
    host: "x.example.org",
    operator: "example.org",
  });
  const good = {
    vault_id: 1,
    sources: [src("A"), src("B"), src("C")],
    distinct_hosts: 3,
    distinct_operators: 3,
    independent: true,
    quorum: 2,
    repo_url: "https://github.com/a/b",
    signer_hash: "d".repeat(64),
    npm_package: "p",
    docker_image: "",
  };

  it("parses", () => {
    const s = parseVerifierSources(good);
    expect(s.sources.map((x) => x.slot)).toEqual(["A", "B", "C"]);
    expect(s.independent).toBe(true);
  });

  it("rejects an unknown slot and a wrong count", () => {
    expect(() => parseVerifierSources({ ...good, sources: [src("A"), src("B"), src("Z")] })).toThrow(ParseError);
    expect(() => parseVerifierSources({ ...good, sources: [src("A")] })).toThrow(ParseError);
  });

  it("rejects a non-boolean independence flag", () => {
    expect(() => parseVerifierSources({ ...good, independent: "yes" })).toThrow(ParseError);
  });
});

describe("parseMilestoneStatus", () => {
  const good = {
    ...tranche(2),
    vault_id: 1,
    previous_tag: "v0.1.0-alpha.1",
    source_urls: ["a", "b", "c"],
    claimable_now: false,
  };

  it("parses", () => {
    const m = parseMilestoneStatus(good);
    expect(m.milestoneId).toBe(2);
    expect(m.previousTag).toBe("v0.1.0-alpha.1");
  });

  it.each([
    [{ milestone_id: 4 }],
    [{ source_urls: ["a"] }],
    [{ status: "NOPE" }],
    [{ claimable_now: "no" }],
  ])("rejects %j", (over) => {
    expect(() => parseMilestoneStatus({ ...good, ...over })).toThrow(ParseError);
  });
});

describe("parseProtocolState and parseClaimResult", () => {
  it("parses protocol state", () => {
    const p = parseProtocolState({
      vault_count: 2,
      next_vault_id: 3,
      total_escrow: "1000",
      total_released: "0",
      total_slashed: "0",
      total_cancelled: "0",
      contract_balance: "1000",
      solvent: true,
    });
    expect(p.totalEscrow).toBe(1000n);
    expect(p.solvent).toBe(true);
  });

  it("parses each verdict", () => {
    for (const verdict of [0, 1, 2]) {
      const r = parseClaimResult({
        verdict,
        milestone_id: 1,
        source_count: 2,
        release_tag: verdict === 1 ? "v0.1.0-alpha.1" : "",
        verified_ts: verdict === 1 ? 1760000001 : 0,
        released: verdict === 1 ? "100" : "0",
        accepted: verdict === 1,
        commit_sha: verdict === 1 ? "1".repeat(40) : "",
        artifact_digest: verdict === 1 ? `sha256:${"a".repeat(64)}` : "",
      });
      expect(r.verdict).toBe(verdict);
    }
  });

  it("rejects an unknown verdict", () => {
    expect(() =>
      parseClaimResult({ verdict: 7, milestone_id: 1, source_count: 0, release_tag: "", verified_ts: 0, released: "0", accepted: false, commit_sha: "", artifact_digest: "" }),
    ).toThrow(ParseError);
  });
});
