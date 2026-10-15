/**
 * Client-side preview of what each verifier mirror says about a milestone.
 *
 * This mirrors `_classify_source` in contracts/ship_or_slash.py so the radar can
 * show, before anyone spends a fee, what each of the three mirrors is serving
 * and what the quorum would make of it. It is a PREVIEW: the browser's view of
 * a mirror is not consensus, and the chain's verdict is the only one that
 * moves funds.
 */

import { isPyInt, parseStrictJson, PyFloat, pyIntValue, type StrictJson } from "./strictJson";
import {
  canonHash,
  normalizeRepo,
  parseSemver,
  compareSemver,
  QUORUM,
  semverFitsMilestone,
  VERDICT,
  type MilestoneId,
  type SourceState,
  type Verdict,
} from "./protocol";

export interface VerifyContext {
  repo: string; // canonical repository URL
  signer: string; // lowercase sha256 hex
  prefix: "" | "v";
  npm: string;
  docker: string;
  milestone: MilestoneId;
  previousTag: string;
  /** Commits that already earned an earlier tranche of this vault. */
  usedCommits: readonly string[];
  /** Artifact digests that already earned an earlier tranche of this vault. */
  usedDigests: readonly string[];
}

export interface SourceReading {
  state: SourceState;
  tag: string;
  commit: string;
  ts: bigint;
  /** Artifact registry and digest this mirror vouches for ("" unless confirmed). */
  registry: string;
  digest: string;
  /** Why the source landed in this state. For humans; never parsed. */
  reason: string;
}

const MAX_BODY_BYTES = 32_768;
const CI_PENDING = new Set(["pending", "queued", "in_progress", "waiting", "requested"]);

const isHex = (s: unknown, n: number): s is string => typeof s === "string" && s.length === n && /^[0-9a-f]+$/.test(s);

function reading(
  state: SourceState,
  reason: string,
  extra: Partial<Pick<SourceReading, "tag" | "commit" | "ts" | "registry" | "digest">> = {},
): SourceReading {
  return { state, reason, tag: "", commit: "", ts: 0n, registry: "", digest: "", ...extra };
}

type Obj = { [key: string]: StrictJson };
const isObj = (v: unknown): v is Obj =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof PyFloat);

/** Pure: turns an HTTP status and body into a per-source reading. Mirrors
 * `_classify_source` step for step, including its order, so the first rule a
 * record breaks is the same one the contract reports. */
export function classifySource(
  status: number | null,
  body: string | null,
  ctx: VerifyContext,
): SourceReading {
  if (status === null || !Number.isInteger(status)) return reading("OUTAGE", "No response.");
  if (status === 404 || status === 410) return reading("NOT_FOUND", `Mirror answered ${status}: record not published yet.`);
  if (status < 200 || status >= 300) return reading("OUTAGE", `Mirror answered ${status}.`);
  if (body === null || new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    return reading("OUTAGE", "Body missing or larger than 32 KiB.");
  }
  let data: StrictJson;
  try {
    data = parseStrictJson(body);
  } catch {
    // Python's json.loads would raise too, and the contract calls that an outage.
    return reading("OUTAGE", "Body is not valid JSON.");
  }
  if (!isObj(data)) return reading("OUTAGE", "Body is not a JSON object.");
  const d = data;
  const fail = (why: string) => reading("FAILED", why);

  if (d.schema !== "shiporslash/v1") return fail("Unknown record schema.");
  if (normalizeRepo(typeof d.repo_url === "string" ? d.repo_url : "") !== ctx.repo) {
    return fail("Record is for a different repository.");
  }
  const mid = d.milestone_id;
  if (!isPyInt(mid) || pyIntValue(mid) !== BigInt(ctx.milestone)) {
    return fail(
      mid instanceof PyFloat
        ? `milestone_id ${mid.literal} is a float; the contract requires an integer.`
        : "Record is for a different milestone.",
    );
  }
  if (typeof d.found !== "boolean") return fail("Record has no found flag.");
  if (!d.found) return fail("Mirror reports the release tag as missing.");

  const tag = d.release_tag;
  if (typeof tag !== "string") return fail("Record has no release tag.");
  const parsed = parseSemver(tag, ctx.prefix);
  if (parsed === null) return fail("Release tag is not valid SemVer.");
  if (!semverFitsMilestone(parsed, ctx.milestone)) return fail("Release tag has the wrong shape for this tranche.");
  if (ctx.previousTag !== "") {
    const prev = parseSemver(ctx.previousTag, ctx.prefix);
    if (prev !== null && compareSemver(parsed, prev) <= 0) return fail("Release does not advance past the previous tranche.");
  }
  const commit = d.commit_sha;
  if (!isHex(commit, 40)) return fail("Commit hash is not 40 lowercase hex characters.");
  if (d.signature_verified !== true) return fail("Commit signature is not verified.");
  const signer = typeof d.signer_fingerprint_sha256 === "string" ? canonHash(d.signer_fingerprint_sha256) : "";
  if (signer !== ctx.signer) {
    return fail(
      d.signer_fingerprint_sha256 === undefined
        ? "Record carries no signer fingerprint."
        : "Signed by a key other than the committed signer.",
    );
  }
  const ts = d.verified_ts;
  if (!isPyInt(ts) || pyIntValue(ts) <= 0n) {
    return fail(
      ts instanceof PyFloat
        ? `verified_ts ${ts.literal} is a float; the contract requires an integer.`
        : "Verification timestamp is invalid.",
    );
  }

  const ci = typeof d.ci_status === "string" ? d.ci_status.toLowerCase() : null;
  if (ci === null) return fail("Record has no CI status.");
  if (CI_PENDING.has(ci)) return reading("NOT_FOUND", "CI has not finished.");
  if (ci !== "success") return fail(`CI status is ${ci}.`);

  const a = d.artifact;
  if (!isObj(a)) return fail("Record has no package artifact.");
  const registry = a.registry;
  const expected = registry === "npm" ? ctx.npm : registry === "docker" ? ctx.docker : "";
  if (expected === "" || a.name !== expected) return fail("Artifact is not a committed registry target.");
  if (typeof a.published !== "boolean") return fail("Artifact has no published flag.");
  if (!a.published) return reading("NOT_FOUND", "Package registry has not caught up.");
  const digest = a.digest;
  if (typeof digest !== "string" || !digest.startsWith("sha256:") || !isHex(digest.slice(7), 64)) {
    return fail("Artifact digest is malformed.");
  }
  if (a.version !== tag.slice(ctx.prefix.length)) return fail("Artifact version does not match the release tag.");
  // One shipped build earns one tranche.
  if (ctx.usedCommits.includes(commit)) return fail("This commit already earned an earlier tranche.");
  if (ctx.usedDigests.includes(digest)) return fail("This artifact digest already earned an earlier tranche.");

  return reading("CONFIRMED", "Signed release, passing CI, package published.", {
    tag,
    commit,
    ts: pyIntValue(ts),
    registry: registry as string,
    digest,
  });
}

export interface Fetcher {
  (url: string): Promise<{ status: number; text: string }>;
}

const browserFetch: Fetcher = async (url) => {
  const res = await fetch(url, { cache: "no-store" });
  return { status: res.status, text: await res.text() };
};

/** Fetches one mirror and classifies it. Never throws. */
export async function probeSource(
  url: string,
  ctx: VerifyContext,
  fetcher: Fetcher = browserFetch,
): Promise<SourceReading> {
  try {
    const { status, text } = await fetcher(url);
    return classifySource(status, text, ctx);
  } catch {
    return reading("OUTAGE", "Request failed (network or CORS).");
  }
}

export interface Corroboration {
  verdict: Verdict;
  /** Responding sources (confirmed + failed + missing); outages do not count. */
  sourceCount: number;
  /** Confirmed readings that agree on the whole release identity. */
  agreeing: number;
  tag: string;
  commit: string;
  digest: string;
  verifiedTs: bigint;
  /** Confirmed readings exist that disagree on tag, commit, registry or digest. */
  conflict: boolean;
}

/** Direct port of the contract's five-step `_aggregate`:
 *  1. tally  2. fewer than two answered -> retry  3. two confirmations that
 *  agree on (tag, commit, registry, digest) -> verified  4. two failed/missing
 *  -> rejected  5. otherwise retry only if the unreachable source could still
 *  complete a quorum. */
export function corroborate(readings: readonly SourceReading[]): Corroboration {
  const confirmed = readings.filter((r) => r.state === "CONFIRMED");
  const failed = readings.filter((r) => r.state === "FAILED").length;
  const missing = readings.filter((r) => r.state === "NOT_FOUND").length;
  const outage = readings.filter((r) => r.state === "OUTAGE").length;
  const responded = confirmed.length + failed + missing;

  const groups = new Map<string, SourceReading[]>();
  for (const r of confirmed) {
    const k = [r.tag, r.commit, r.registry, r.digest].join("\u0000");
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  let best: SourceReading[] = [];
  for (const k of Array.from(groups.keys()).sort()) {
    const g = groups.get(k)!;
    if (g.length > best.length) best = g;
  }
  const conflict = groups.size > 1;
  const out = (verdict: Verdict, tag = "", commit = "", digest = "", verifiedTs = 0n): Corroboration => ({
    verdict,
    sourceCount: responded,
    agreeing: best.length,
    tag,
    commit,
    digest,
    verifiedTs,
    conflict,
  });

  if (responded < QUORUM) return out(VERDICT.QUORUM_FAILURE);
  if (best.length >= QUORUM) {
    const first = best[0]!;
    return out(VERDICT.VERIFIED, first.tag, first.commit, first.digest, best.reduce((m, r) => (r.ts < m ? r.ts : m), first.ts));
  }
  if (failed + missing >= QUORUM) return out(VERDICT.REJECTED);
  if (outage >= 1 && (best.length + outage >= QUORUM || failed + missing + outage >= QUORUM)) {
    return out(VERDICT.QUORUM_FAILURE);
  }
  return out(VERDICT.REJECTED);
}
