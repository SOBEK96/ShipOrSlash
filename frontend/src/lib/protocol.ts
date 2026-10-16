/**
 * Protocol rules the contract enforces, restated client-side so the console can
 * reject a malformed vault before it spends a fee. Every function here mirrors
 * a function in contracts/ship_or_slash.py; the vitest suite pins the same
 * boundary cases the pytest suite pins. Integer-only: amounts are bigint, shares
 * are basis points, and nothing here ever touches a float.
 */

export const BPS_DENOM = 10_000n;
export const TRANCHE_BPS = [2000, 3000, 5000] as const;
export const CUM_BPS = [0n, 2000n, 5000n, 10_000n] as const;
export const TRANCHE_KINDS = ["ALPHA", "RC", "STABLE"] as const;
export type TrancheKind = (typeof TRANCHE_KINDS)[number];
export type MilestoneId = 1 | 2 | 3;

export const ATTO = 10n ** 18n;
export const MIN_DEPOSIT = ATTO / 1000n; // 0.001 GEN
/** The beneficiary has this long to inspect and accept a new vault. */
export const ACCEPTANCE_WINDOW_S = 2 * 86_400;
/** Once accepted, a vault still runs at least this long. */
export const MIN_WINDOW_S = 86_400;
/** A new vault's deadline must leave the whole acceptance window usable and a
 * full day after it, so accepting at the last moment never leaves less than
 * MIN_WINDOW_S to ship. */
export const MIN_DEADLINE_S = ACCEPTANCE_WINDOW_S + MIN_WINDOW_S;
export const MIN_DEADLINE_DAYS = MIN_DEADLINE_S / 86_400;
export const MAX_WINDOW_S = 5 * 365 * 86_400;
export const QUORUM = 2;
export const SOURCES = 3;

export const VERDICT = { REJECTED: 0, VERIFIED: 1, QUORUM_FAILURE: 2 } as const;
export type Verdict = (typeof VERDICT)[keyof typeof VERDICT];

export function isMilestoneId(n: number): n is MilestoneId {
  return n === 1 || n === 2 || n === 3;
}

/** Cumulative amount owed once `tranche` tranches are accepted. */
export function cumEntitlement(deposited: bigint, tranche: 0 | 1 | 2 | 3): bigint {
  const cum = CUM_BPS[tranche];
  if (cum === undefined) throw new RangeError("tranche out of range");
  return (deposited * cum) / BPS_DENOM;
}

/** The three tranche amounts for a deposit. The last absorbs every remainder,
 * so the amounts always sum to the deposit exactly. */
export function trancheAmounts(deposited: bigint): [bigint, bigint, bigint] {
  const c1 = cumEntitlement(deposited, 1);
  const c2 = cumEntitlement(deposited, 2);
  const c3 = cumEntitlement(deposited, 3);
  return [c1, c2 - c1, c3 - c2];
}

/**
 * What `claim_milestone` pays for tranche `tranche` right now: the cumulative
 * entitlement at the current deposit, less everything already released. This is
 * exactly the contract's `_cum_entitlement(deposited, k) - released`, and it
 * differs from the tranche's nominal share after a top-up.
 */
export function nextReleaseAmount(deposited: bigint, released: bigint, tranche: 1 | 2 | 3): bigint {
  return cumEntitlement(deposited, tranche) - released;
}

/**
 * Amounts for every tranche that has not been accepted, mirroring the
 * contract's `_tranche_view`: the next tranche pays its catch-up share
 * (`nextReleaseAmount`), later ones show their nominal share. Accepted
 * tranches are `null` -- their amount is whatever the chain recorded.
 */
export function projectPending(
  deposited: bigint,
  released: bigint,
  tranchesDone: number,
): [bigint | null, bigint | null, bigint | null] {
  const out: (bigint | null)[] = [null, null, null];
  for (const k of [1, 2, 3] as const) {
    if (k <= tranchesDone) continue;
    out[k - 1] =
      k === tranchesDone + 1
        ? nextReleaseAmount(deposited, released, k)
        : cumEntitlement(deposited, k) - cumEntitlement(deposited, (k - 1) as 0 | 1 | 2);
  }
  return [out[0]!, out[1]!, out[2]!];
}

// --------------------------------------------------------------- SemVer ----
export interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

const SEMVER_ID = /^[0-9A-Za-z-]+$/;

/** Strict SemVer 2.0.0 without build metadata. `prefix` is "" or "v". */
export function parseSemver(tag: string, prefix: "" | "v"): Semver | null {
  if (typeof tag !== "string" || tag === "" || tag.length > 64) return null;
  let body = tag;
  if (prefix !== "") {
    if (!body.startsWith(prefix)) return null;
    body = body.slice(prefix.length);
  }
  if (body === "" || body.includes("+") || body[0] === "v" || body[0] === "V") return null;
  const dash = body.indexOf("-");
  const core = dash === -1 ? body : body.slice(0, dash);
  const preRaw = dash === -1 ? null : body.slice(dash + 1);
  const parts = core.split(".");
  if (parts.length !== 3) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^[0-9]+$/.test(p) || p.length > 9) return null;
    if (p.length > 1 && p.startsWith("0")) return null;
    nums.push(Number(p));
  }
  const pre: string[] = [];
  if (preRaw !== null) {
    if (preRaw === "") return null;
    for (const id of preRaw.split(".")) {
      if (id === "" || !SEMVER_ID.test(id)) return null;
      if (/^[0-9]+$/.test(id) && id.length > 1 && id.startsWith("0")) return null;
      pre.push(id);
    }
  }
  return { major: nums[0]!, minor: nums[1]!, patch: nums[2]!, pre };
}

function cmpId(a: string, b: string): number {
  const an = /^[0-9]+$/.test(a);
  const bn = /^[0-9]+$/.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  if (an !== bn) return an ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SemVer precedence: -1, 0 or 1. */
export function compareSemver(a: Semver, b: Semver): -1 | 0 | 1 {
  for (const k of ["major", "minor", "patch"] as const) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const n = Math.min(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i++) {
    const c = cmpId(a.pre[i]!, b.pre[i]!);
    if (c !== 0) return c < 0 ? -1 : 1;
  }
  return Math.sign(a.pre.length - b.pre.length) as -1 | 0 | 1;
}

/** The release shape each tranche requires. */
export function semverFitsMilestone(v: Semver, milestone: MilestoneId): boolean {
  if (milestone === 1) return v.pre.length >= 1 && (v.pre[0] === "alpha" || v.pre[0] === "beta");
  if (milestone === 2) return v.pre.length >= 1 && v.pre[0] === "rc";
  return v.pre.length === 0 && v.major >= 1;
}

export interface TagCheck {
  ok: boolean;
  reason: string;
}

/** Explains whether `tag` could satisfy `milestone` after `previous`. */
export function checkTag(
  tag: string,
  milestone: MilestoneId,
  prefix: "" | "v",
  previous = "",
): TagCheck {
  const v = parseSemver(tag, prefix);
  if (v === null) return { ok: false, reason: `Not a SemVer 2.0.0 tag${prefix ? ` with the "${prefix}" prefix` : ""}.` };
  if (!semverFitsMilestone(v, milestone)) {
    const need =
      milestone === 1
        ? "an -alpha or -beta pre-release"
        : milestone === 2
          ? "an -rc pre-release"
          : "a stable release of 1.0.0 or later";
    return { ok: false, reason: `Tranche ${milestone} needs ${need}.` };
  }
  if (previous !== "") {
    const p = parseSemver(previous, prefix);
    if (p !== null && compareSemver(v, p) <= 0) {
      return { ok: false, reason: `Must be newer than ${previous}.` };
    }
  }
  return { ok: true, reason: "Valid." };
}

// ------------------------------------------------------------- Registry ----
const NAME_CHARS = /^[A-Za-z0-9._-]+$/;
const REPO_HOSTS = new Set(["github.com", "gitlab.com"]);

/** Canonical repository URL, or "" when the contract would reject it. */
export function normalizeRepo(url: string): string {
  if (typeof url !== "string" || url === "" || url.length > 300) return "";
  if (url.includes("\\") || /[^\x21-\x7e]/.test(url)) return "";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "";
  }
  if (u.protocol !== "https:" || !REPO_HOSTS.has(u.hostname.toLowerCase())) return "";
  if (u.port !== "" || u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") return "";
  let path = u.pathname.replace(/^\/+|\/+$/g, "");
  if (path.endsWith(".git")) path = path.slice(0, -4);
  const segs = path.split("/");
  if (segs.length !== 2) return "";
  for (const s of segs) {
    if (s === "" || s === "." || s === ".." || !NAME_CHARS.test(s)) return "";
  }
  return `https://${u.hostname.toLowerCase()}/${segs[0]!.toLowerCase()}/${segs[1]!.toLowerCase()}`;
}

/** Lowercase 64-hex digest (a leading 0x is tolerated), or "" when malformed. */
export function canonHash(h: string): string {
  if (typeof h !== "string") return "";
  let s = h.trim().toLowerCase();
  if (s.startsWith("0x")) s = s.slice(2);
  return /^[0-9a-f]{64}$/.test(s) ? s : "";
}

/** SHA-256 hex of a GPG fingerprint, normalised the way the fixtures hash it. */
export async function fingerprintHash(fingerprint: string): Promise<string> {
  const norm = fingerprint.replace(/\s+/g, "").toUpperCase();
  const data = new TextEncoder().encode(norm);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function validArtifactTarget(name: string): boolean {
  if (name === "") return true;
  if (name.length > 100 || /[^\x20-\x7e]/.test(name)) return false;
  return !/[ "\\<>]/.test(name);
}

// ---------------------------------------------------------------- Feeds ----
const OPERATOR_SUFFIXES: ReadonlyArray<readonly [string, string]> = [
  ["githubusercontent.com", "github"],
  ["github.com", "github"],
  ["github.io", "github"],
  ["jsdelivr.net", "jsdelivr"],
  ["githack.com", "githack"],
  ["gitlab.com", "gitlab"],
  ["gitlab.io", "gitlab"],
  ["npmjs.org", "npm"],
  ["npmjs.com", "npm"],
  ["unpkg.com", "unpkg"],
  ["docker.io", "docker"],
  ["docker.com", "docker"],
];

/** Hostname of a verifier base URL, or "" when the contract would reject it. */
export function feedHost(url: string): string {
  if (typeof url !== "string" || url === "" || url.length > 300) return "";
  if (url.includes("\\") || /[^\x21-\x7e]/.test(url)) return "";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "";
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || host === "" || u.port !== "") return "";
  if (u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") return "";
  if (!u.pathname.endsWith("/") || !host.includes(".")) return "";
  if (!/^[a-z0-9.-]+$/.test(host)) return "";
  const labels = host.split(".");
  if (labels.some((l) => l === "" || l.startsWith("-") || l.endsWith("-"))) return "";
  if (/^[0-9]+$/.test(labels[labels.length - 1]!) || host === "localhost") return "";
  for (const bad of [".local", ".localhost", ".internal", ".lan", ".home", ".corp"]) {
    if (host.endsWith(bad)) return "";
  }
  return host;
}

export function operatorOf(host: string): string {
  for (const [suffix, op] of OPERATOR_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return op;
  }
  return host.split(".").slice(-2).join(".");
}

export interface FeedAssessment {
  hosts: string[];
  operators: string[];
  problems: string[];
  independent: boolean;
}

/** Whether three base URLs would pass the contract's independence rule. */
export function assessFeeds(urls: readonly [string, string, string]): FeedAssessment {
  const hosts: string[] = [];
  const operators: string[] = [];
  const problems: string[] = [];
  urls.forEach((u, i) => {
    const h = feedHost(u);
    if (h === "") {
      problems.push(`Slot ${"ABC"[i]} is not a safe https base URL ending in "/".`);
      hosts.push("");
      operators.push("");
    } else {
      hosts.push(h);
      operators.push(operatorOf(h));
    }
  });
  if (problems.length === 0) {
    if (new Set(hosts).size !== SOURCES) problems.push("The three mirrors must use three distinct hostnames.");
    else if (new Set(operators).size !== SOURCES) problems.push("The three mirrors must be run by three distinct operators.");
  }
  return { hosts, operators, problems, independent: problems.length === 0 };
}

// ---------------------------------------------------------------- Quorum ----
export type SourceState = "CONFIRMED" | "FAILED" | "NOT_FOUND" | "OUTAGE";

/** The verdict the contract would reach for these per-source states, assuming
 * all confirmed sources agree on the release.
 *
 * Two agreeing confirmations verify. Two EXPLICIT rejections (FAILED: the mirror
 * answered and its record says the release is invalid) reject. Everything else
 * is unproven either way and is retryable. NOT_FOUND (404, CI still running,
 * package not yet published) and OUTAGE are lag: they prove nothing, so a
 * missing record is never a rejection. */
export function quorumOutlook(states: readonly SourceState[]): Verdict {
  const c = states.filter((s) => s === "CONFIRMED").length;
  const f = states.filter((s) => s === "FAILED").length;
  if (c >= QUORUM) return VERDICT.VERIFIED;
  if (f >= QUORUM) return VERDICT.REJECTED;
  return VERDICT.QUORUM_FAILURE;
}
