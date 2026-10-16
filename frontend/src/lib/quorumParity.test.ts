import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifySource, corroborate, type SourceReading, type VerifyContext } from "./verify";

/**
 * tests/vectors/quorum_parity.json: scenarios run through the real contract
 * (pytest keeps it exact), with the verdict and the release identity it
 * accepted. The preview must reach the same verdict for every one, in
 * particular for conflicting digests, reused commits and missing signers --
 * the cases where a preview that is more lenient than the contract shows a
 * false "Verified".
 */
interface Scenario {
  name: string;
  tranche: 1 | 2 | 3;
  bodies: string[];
  context: {
    repo: string;
    signer: string;
    prefix: "" | "v";
    npm: string;
    docker: string;
    previous_tag: string;
    used_commits: string[];
    used_digests: string[];
  };
  verdict: 0 | 1 | 2;
  source_count: number;
  release_tag: string;
  commit_sha: string;
  artifact_digest: string;
}

const doc = JSON.parse(
  readFileSync(join(__dirname, "../../../tests/vectors/quorum_parity.json"), "utf8"),
) as { scenarios: Scenario[] };

/** The vectors carry mirror outcomes as bare status strings or JSON bodies. */
function read(body: string, ctx: VerifyContext): SourceReading {
  if (/^[0-9]{3}$/.test(body)) return classifySource(Number(body), "", ctx);
  return classifySource(200, body, ctx);
}

describe("quorum scenarios: the preview reaches the contract's verdict", () => {
  it("covers verified, rejected and retryable outcomes", () => {
    const verdicts = new Set(doc.scenarios.map((s) => s.verdict));
    expect([...verdicts].sort()).toEqual([0, 1, 2]);
    expect(doc.scenarios.length).toBeGreaterThanOrEqual(20);
  });

  doc.scenarios.forEach((sc) => {
    it(`${sc.name} -> ${["rejected", "verified", "retryable"][sc.verdict]}`, () => {
      const ctx: VerifyContext = {
        repo: sc.context.repo,
        signer: sc.context.signer,
        prefix: sc.context.prefix,
        npm: sc.context.npm,
        docker: sc.context.docker,
        milestone: sc.tranche,
        previousTag: sc.context.previous_tag,
        usedCommits: sc.context.used_commits,
        usedDigests: sc.context.used_digests,
      };
      const out = corroborate(sc.bodies.map((b) => read(b, ctx)));
      expect(out.verdict).toBe(sc.verdict);
      expect(out.sourceCount).toBe(sc.source_count);
      expect(out.tag).toBe(sc.release_tag);
      expect(out.commit).toBe(sc.commit_sha);
      expect(out.digest).toBe(sc.artifact_digest);
    });
  });

  it.each(["digest_conflict_with_404", "t2_reuses_commit_all", "t2_reuses_digest_two_of_three", "missing_signer_two_of_three"])(
    "never previews %s as verified",
    (name) => {
      const sc = doc.scenarios.find((s) => s.name === name)!;
      expect(sc).toBeDefined();
      expect(sc.verdict).not.toBe(1);
      const ctx: VerifyContext = {
        repo: sc.context.repo, signer: sc.context.signer, prefix: sc.context.prefix, npm: sc.context.npm,
        docker: sc.context.docker, milestone: sc.tranche, previousTag: sc.context.previous_tag,
        usedCommits: sc.context.used_commits, usedDigests: sc.context.used_digests,
      };
      expect(corroborate(sc.bodies.map((b) => read(b, ctx))).verdict).not.toBe(1);
    },
  );
});

describe("lag scenarios: a missing record is never previewed as a rejection", () => {
  it.each([
    "lone_confirmation_two_404", "lone_confirmation_404_outage", "lone_confirmation_two_outages", "all_404",
    "ci_pending_lag", "one_explicit_rejection_two_404", "digest_conflict_with_404", "commit_conflict_with_404",
  ])("%s is retryable", (name) => {
    const sc = doc.scenarios.find((x) => x.name === name)!;
    expect(sc, name).toBeDefined();
    expect(sc.verdict).toBe(2);
    const ctx: VerifyContext = {
      repo: sc.context.repo, signer: sc.context.signer, prefix: sc.context.prefix, npm: sc.context.npm,
      docker: sc.context.docker, milestone: sc.tranche, previousTag: sc.context.previous_tag,
      usedCommits: sc.context.used_commits, usedDigests: sc.context.used_digests,
    };
    expect(corroborate(sc.bodies.map((b) => read(b, ctx))).verdict).toBe(2);
  });

  it.each(["two_explicit_rejections_and_a_404", "ci_failure_two_mirrors", "confirm_and_two_explicit_rejections"])(
    "%s is positive proof and rejects",
    (name) => {
      expect(doc.scenarios.find((x) => x.name === name)!.verdict).toBe(0);
    },
  );
});
