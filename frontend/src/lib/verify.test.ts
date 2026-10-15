import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { corroborate, classifySource, probeSource, type SourceReading, type VerifyContext } from "./verify";

const SIGNER = "d8a87fdcd4224662af9b788cae845191b3bc64b8155eb124fdbe0d506e4fcf10";
const ctx = (m: 1 | 2 | 3 = 1, over: Partial<VerifyContext> = {}): VerifyContext => ({
  repo: "https://github.com/sobek96/shiporslash",
  signer: SIGNER,
  prefix: "v",
  npm: "@sobek96/shiporslash",
  docker: "sobek96/shiporslash",
  milestone: m,
  previousTag: "",
  ...over,
});

const TAGS: Record<number, string> = { 1: "v0.1.0-alpha.1", 2: "v0.9.0-rc.1", 3: "v1.0.0" };
const rec = (m: number, over: Record<string, unknown> = {}) => {
  const out: Record<string, unknown> = {
    schema: "shiporslash/v1",
    repo_url: "https://github.com/SOBEK96/ShipOrSlash",
    milestone_id: m,
    found: true,
    release_tag: TAGS[m],
    commit_sha: String(m).repeat(40),
    signature_verified: true,
    signer_fingerprint_sha256: SIGNER,
    ci_status: "success",
    artifact: {
      registry: "npm",
      name: "@sobek96/shiporslash",
      version: TAGS[m]!.slice(1),
      published: true,
      digest: `sha256:${"a".repeat(64)}`,
    },
    verified_ts: 1760000000 + m,
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
};
const art = (m: number, over: Record<string, unknown>) => ({ ...(rec(m).artifact as object), ...over });
const body = (o: unknown) => JSON.stringify(o);

describe("committed fixture files", () => {
  for (const slot of ["a", "b", "c"]) {
    for (const m of [1, 2, 3] as const) {
      it(`slot ${slot} milestone ${m} is CONFIRMED`, () => {
        const text = readFileSync(join(__dirname, "../../../deployments/mock_feeds", slot, `milestone_${m}.json`), "utf8");
        const prev = m === 1 ? "" : TAGS[m - 1]!;
        const r = classifySource(200, text, ctx(m, { previousTag: prev }));
        expect(r.state, r.reason).toBe("CONFIRMED");
        expect(r.tag).toBe(TAGS[m]);
      });
    }
  }
});

describe("classifySource: transport", () => {
  it.each([
    [null, "OUTAGE"],
    [404, "NOT_FOUND"],
    [410, "NOT_FOUND"],
    [500, "OUTAGE"],
    [502, "OUTAGE"],
    [503, "OUTAGE"],
    [429, "OUTAGE"],
    [403, "OUTAGE"],
    [301, "OUTAGE"],
    [199, "OUTAGE"],
  ] as const)("status %s -> %s", (status, want) => {
    expect(classifySource(status, "", ctx()).state).toBe(want);
  });

  it.each(["<html>", "", "not json", "[]", "42", "null", '"s"'])("body %j is an outage, never a rejection", (b) => {
    expect(classifySource(200, b, ctx()).state).toBe("OUTAGE");
  });

  it("treats an oversized body as an outage", () => {
    expect(classifySource(200, body({ ...rec(1), pad: "x".repeat(40_000) }), ctx()).state).toBe("OUTAGE");
  });

  it("confirms a valid record", () => {
    const r = classifySource(200, body(rec(1)), ctx());
    expect(r.state).toBe("CONFIRMED");
    expect(r.tag).toBe("v0.1.0-alpha.1");
    expect(r.ts).toBe(1760000001);
  });
});

describe("classifySource: tampering is FAILED", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["wrong schema", { schema: "other" }],
    ["wrong repo", { repo_url: "https://github.com/evil/fork" }],
    ["wrong milestone", { milestone_id: 3 }],
    ["milestone as string", { milestone_id: "1" }],
    ["found false", { found: false }],
    ["found as string", { found: "true" }],
    ["no tag", { release_tag: undefined }],
    ["bad semver", { release_tag: "v1.0" }],
    ["wrong shape", { release_tag: "v0.1.0" }],
    ["bad commit", { commit_sha: "xyz" }],
    ["upper-case commit", { commit_sha: "A".repeat(40) }],
    ["unsigned", { signature_verified: false }],
    ["signed as string", { signature_verified: "true" }],
    ["wrong signer", { signer_fingerprint_sha256: "b".repeat(64) }],
    ["no signer", { signer_fingerprint_sha256: undefined }],
    ["ts zero", { verified_ts: 0 }],
    ["ts float", { verified_ts: 1.5 }],
    ["ts missing", { verified_ts: undefined }],
    ["ci failure", { ci_status: "failure" }],
    ["ci cancelled", { ci_status: "cancelled" }],
    ["ci missing", { ci_status: undefined }],
    ["no artifact", { artifact: undefined }],
    ["wrong registry", { artifact: art(1, { registry: "pypi" }) }],
    ["wrong name", { artifact: art(1, { name: "@evil/pkg" }) }],
    ["bad digest", { artifact: art(1, { digest: "sha256:abc" }) }],
    ["version mismatch", { artifact: art(1, { version: "9.9.9" }) }],
    ["published as string", { artifact: art(1, { published: "yes" }) }],
  ];
  it.each(cases)("%s", (_n, over) => {
    expect(classifySource(200, body(rec(1, over)), ctx()).state).toBe("FAILED");
  });

  it("rejects a tag that does not advance past the previous tranche", () => {
    const r = classifySource(200, body(rec(2, { release_tag: "v0.0.5-rc.1", artifact: art(2, { version: "0.0.5-rc.1" }) })), ctx(2, { previousTag: "v0.1.0-alpha.1" }));
    expect(r.state).toBe("FAILED");
  });

  it("rejects a docker artifact when only npm is committed", () => {
    const r = classifySource(200, body(rec(1, { artifact: art(1, { registry: "docker", name: "sobek96/shiporslash" }) })), ctx(1, { docker: "" }));
    expect(r.state).toBe("FAILED");
  });
});

describe("classifySource: lag is NOT_FOUND, not FAILED", () => {
  it.each(["pending", "queued", "in_progress", "waiting", "requested"])("ci %s", (ci) => {
    expect(classifySource(200, body(rec(1, { ci_status: ci })), ctx()).state).toBe("NOT_FOUND");
  });
  it("unpublished artifact", () => {
    expect(classifySource(200, body(rec(1, { artifact: art(1, { published: false }) })), ctx()).state).toBe("NOT_FOUND");
  });
  it("accepts a bare-tag vault", () => {
    const r = classifySource(
      200,
      body(rec(1, { release_tag: "0.1.0-alpha.1", artifact: art(1, { version: "0.1.0-alpha.1" }) })),
      ctx(1, { prefix: "" }),
    );
    expect(r.state).toBe("CONFIRMED");
  });
});

describe("corroborate (direct port of _aggregate)", () => {
  const c = (tag = "v0.1.0-alpha.1", commit = "1".repeat(40), ts = 10): SourceReading => ({ state: "CONFIRMED", tag, commit, ts, reason: "" });
  const s = (state: SourceReading["state"]): SourceReading => ({ state, tag: "", commit: "", ts: 0, reason: "" });

  it("verifies on two agreeing confirmations and takes the minimum timestamp", () => {
    const r = corroborate([c("v1", "a", 50), c("v1", "a", 20), s("OUTAGE")]);
    expect(r.verdict).toBe(1);
    expect(r.verifiedTs).toBe(20);
    expect(r.sourceCount).toBe(2);
  });

  it("does not corroborate the same tag on different commits", () => {
    expect(corroborate([c("v1", "a"), c("v1", "b"), s("NOT_FOUND")]).verdict).toBe(0);
  });

  it("retries when a conflict could still be broken by the silent mirror", () => {
    expect(corroborate([c("v1", "a"), c("v2", "b"), s("OUTAGE")]).verdict).toBe(2);
  });

  it("the headline case: one confirmation, one 404, one outage is retryable", () => {
    expect(corroborate([c(), s("NOT_FOUND"), s("OUTAGE")]).verdict).toBe(2);
  });

  it("fewer than two answers is retryable", () => {
    expect(corroborate([c(), s("OUTAGE"), s("OUTAGE")]).verdict).toBe(2);
    expect(corroborate([s("OUTAGE"), s("OUTAGE"), s("OUTAGE")]).verdict).toBe(2);
  });

  it("two failures reject even with one confirmation", () => {
    expect(corroborate([c(), s("FAILED"), s("NOT_FOUND")]).verdict).toBe(0);
  });

  it("majority beats a dissenter", () => {
    expect(corroborate([c("v1", "a"), c("v1", "a"), c("v9", "z")]).verdict).toBe(1);
  });
});

describe("probeSource", () => {
  it("classifies what the fetcher returns", async () => {
    const r = await probeSource("https://x/", ctx(), async () => ({ status: 200, text: body(rec(1)) }));
    expect(r.state).toBe("CONFIRMED");
  });

  it("reports a thrown fetch as an outage, never an exception", async () => {
    const r = await probeSource("https://x/", ctx(), async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(r.state).toBe("OUTAGE");
  });
});
