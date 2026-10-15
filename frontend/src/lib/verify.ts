/**
 * Client-side preview of what each verifier mirror says about a milestone.
 *
 * This mirrors `_classify_source` in contracts/ship_or_slash.py so the radar can
 * show, before anyone spends a fee, what each of the three mirrors is serving
 * and what the quorum would make of it. It is a PREVIEW: the browser's view of
 * a mirror is not consensus, and the chain's verdict is the only one that
 * moves funds.
 */

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
}

export interface SourceReading {
  state: SourceState;
  tag: string;
  commit: string;
  ts: number;
  /** Why the source landed in this state. For humans; never parsed. */
  reason: string;
}

const MAX_BODY_BYTES = 32_768;
const CI_PENDING = new Set(["pending", "queued", "in_progress", "waiting", "requested"]);

const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);
const isHex = (s: unknown, n: number): s is string => typeof s === "string" && s.length === n && /^[0-9a-f]+$/.test(s);

function reading(state: SourceState, reason: string, tag = "", commit = "", ts = 0): SourceReading {
  return { state, tag, commit, ts, reason };
}

/** Pure: turns an HTTP status and body into a per-source reading. */
export function classifySource(
  status: number | null,
  body: string | null,
  ctx: VerifyContext,
): SourceReading {
  if (status === null || !isInt(status)) return reading("OUTAGE", "No response.");
  if (status === 404 || status === 410) return reading("NOT_FOUND", `Mirror answered ${status}: record not published yet.`);
  if (status < 200 || status >= 300) return reading("OUTAGE", `Mirror answered ${status}.`);
  if (body === null || new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    return reading("OUTAGE", "Body missing or larger than 32 KiB.");
  }
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return reading("OUTAGE", "Body is not JSON.");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return reading("OUTAGE", "Body is not a JSON object.");
  }
  const d = data as Record<string, unknown>;
  const fail = (why: string) => reading("FAILED", why);

  if (d.schema !== "shiporslash/v1") return fail("Unknown record schema.");
  if (normalizeRepo(typeof d.repo_url === "string" ? d.repo_url : "") !== ctx.repo) {
    return fail("Record is for a different repository.");
  }
  if (!isInt(d.milestone_id) || d.milestone_id !== ctx.milestone) return fail("Record is for a different milestone.");
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
  if (signer !== ctx.signer) return fail("Signed by a key other than the committed signer.");
  const ts = d.verified_ts;
  if (!isInt(ts) || ts <= 0) return fail("Verification timestamp is invalid.");

  const ci = typeof d.ci_status === "string" ? d.ci_status.toLowerCase() : null;
  if (ci === null) return fail("Record has no CI status.");
  if (CI_PENDING.has(ci)) return reading("NOT_FOUND", "CI has not finished.");
  if (ci !== "success") return fail(`CI status is ${ci}.`);

  const art = d.artifact;
  if (art === null || typeof art !== "object" || Array.isArray(art)) return fail("Record has no package artifact.");
  const a = art as Record<string, unknown>;
  const expected = a.registry === "npm" ? ctx.npm : a.registry === "docker" ? ctx.docker : "";
  if (expected === "" || a.name !== expected) return fail("Artifact is not a committed registry target.");
  if (typeof a.published !== "boolean") return fail("Artifact has no published flag.");
  if (!a.published) return reading("NOT_FOUND", "Package registry has not caught up.");
  if (typeof a.digest !== "string" || !a.digest.startsWith("sha256:") || !isHex(a.digest.slice(7), 64)) {
    return fail("Artifact digest is malformed.");
  }
  if (a.version !== tag.slice(ctx.prefix.length)) return fail("Artifact version does not match the release tag.");

  return reading("CONFIRMED", "Signed release, passing CI, package published.", tag, commit, ts);
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
  /** Confirmed readings that agree on the exact (tag, commit). */
  agreeing: number;
  tag: string;
  verifiedTs: number;
}

/** Direct port of the contract's five-step `_aggregate`:
 *  1. tally  2. fewer than two answered -> retry  3. two agreeing
 *  confirmations -> verified  4. two failed/missing -> rejected  5. otherwise
 *  retry only if the unreachable source could still complete a quorum. */
export function corroborate(readings: readonly SourceReading[]): Corroboration {
  const confirmed = readings.filter((r) => r.state === "CONFIRMED");
  const failed = readings.filter((r) => r.state === "FAILED").length;
  const missing = readings.filter((r) => r.state === "NOT_FOUND").length;
  const outage = readings.filter((r) => r.state === "OUTAGE").length;
  const responded = confirmed.length + failed + missing;
  const out = (verdict: Verdict, agreeing = 0, tag = "", verifiedTs = 0): Corroboration => ({
    verdict,
    sourceCount: responded,
    agreeing,
    tag,
    verifiedTs,
  });

  if (responded < QUORUM) return out(VERDICT.QUORUM_FAILURE);

  const groups = new Map<string, SourceReading[]>();
  for (const r of confirmed) {
    const k = `${r.tag}\u0000${r.commit}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  let best: SourceReading[] = [];
  for (const k of Array.from(groups.keys()).sort()) {
    const g = groups.get(k)!;
    if (g.length > best.length) best = g;
  }
  if (best.length >= QUORUM) {
    return out(VERDICT.VERIFIED, best.length, best[0]!.tag, Math.min(...best.map((r) => r.ts)));
  }
  if (failed + missing >= QUORUM) return out(VERDICT.REJECTED, best.length);
  if (outage >= 1 && (best.length + outage >= QUORUM || failed + missing + outage >= QUORUM)) {
    return out(VERDICT.QUORUM_FAILURE, best.length);
  }
  return out(VERDICT.REJECTED, best.length);
}
