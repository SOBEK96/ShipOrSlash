/**
 * Strict decoding of the contract's view results. The SDK hands back
 * CalldataEncodable values -- Maps for dicts, bigints for ints -- and a hosted
 * network can hand back a partial or stale shape. Nothing here defaults a
 * missing field to zero: a malformed view throws ParseError, and the caller's
 * SerialLoader keeps the last good value for that item instead of rendering a
 * confident wrong number.
 */

import type { MilestoneId, TrancheKind } from "./protocol";

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

export type PlainValue = string | number | boolean | null | PlainValue[] | { [k: string]: PlainValue };

/** Maps -> objects, bigints -> number when safe else decimal string. */
export function toPlain(v: unknown): PlainValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= -BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(v)
      : v.toString();
  }
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new ParseError("non-integer number in view result");
    return v;
  }
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (v instanceof Map) {
    const out: { [k: string]: PlainValue } = {};
    for (const [k, val] of v.entries()) out[String(k)] = toPlain(val);
    return out;
  }
  if (Array.isArray(v)) return v.map(toPlain);
  if (v instanceof Uint8Array) return `0x${Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  if (typeof v === "object") {
    const out: { [k: string]: PlainValue } = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = toPlain(val);
    return out;
  }
  throw new ParseError(`unsupported value type ${typeof v}`);
}

type Obj = { [k: string]: PlainValue };

function obj(v: PlainValue, what: string): Obj {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new ParseError(`${what} is not an object`);
  return v;
}
function str(o: Obj, k: string): string {
  const v = o[k];
  if (typeof v !== "string") throw new ParseError(`${k} must be a string`);
  return v;
}
function int(o: Obj, k: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isInteger(v)) throw new ParseError(`${k} must be an integer`);
  return v;
}
function bool(o: Obj, k: string): boolean {
  const v = o[k];
  if (typeof v !== "boolean") throw new ParseError(`${k} must be a boolean`);
  return v;
}
function wei(o: Obj, k: string): bigint {
  const v = o[k];
  if (typeof v === "string" && /^[0-9]+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return BigInt(v);
  throw new ParseError(`${k} must be a non-negative integer amount`);
}
function arr(o: Obj, k: string): PlainValue[] {
  const v = o[k];
  if (!Array.isArray(v)) throw new ParseError(`${k} must be an array`);
  return v;
}

export type TrancheStatus = "ACCEPTED" | "PENDING" | "LOCKED" | "SLASHED" | "CANCELLED";
/** PENDING_ACCEPTANCE is an offer: the beneficiary has not yet accepted the
 * funder's registry and mirrors. REJECTED and CANCELLED end it with the
 * principal returned to the funder. */
export type VaultStatus = "PENDING_ACCEPTANCE" | "ACTIVE" | "COMPLETE" | "SLASHED" | "REJECTED" | "CANCELLED";

export interface Tranche {
  milestoneId: MilestoneId;
  kind: TrancheKind;
  bps: number;
  status: TrancheStatus;
  releaseTag: string;
  commitSha: string;
  artifactDigest: string;
  verifiedTs: number;
  amount: bigint;
}

export interface VaultState {
  vaultId: number;
  status: VaultStatus;
  funder: string;
  beneficiary: string;
  repoUrl: string;
  signerHash: string;
  tagPrefix: "" | "v";
  npmPackage: string;
  dockerImage: string;
  feeds: [string, string, string];
  deadline: number;
  createdAt: number;
  /** The offer lapses (the funder may cancel) after this. */
  acceptDeadline: number;
  /** 0 until the beneficiary accepts. */
  acceptedAt: number;
  deposited: bigint;
  released: bigint;
  withdrawn: bigint;
  reclaimed: bigint;
  withdrawable: bigint;
  unreleased: bigint;
  tranchesDone: number;
  attempts: number;
  lastVerdict: number;
  lastSourceCount: number;
  lastAttemptAt: number;
  lastMilestone: number;
  tranches: [Tranche, Tranche, Tranche];
}

const TRANCHE_STATUSES: readonly string[] = ["ACCEPTED", "PENDING", "LOCKED", "SLASHED", "CANCELLED"];
const VAULT_STATUSES: readonly string[] = ["PENDING_ACCEPTANCE", "ACTIVE", "COMPLETE", "SLASHED", "REJECTED", "CANCELLED"];
const KINDS: readonly string[] = ["ALPHA", "RC", "STABLE"];

function parseTranche(v: PlainValue, expectId: MilestoneId): Tranche {
  const o = obj(v, "tranche");
  const id = int(o, "milestone_id");
  if (id !== expectId) throw new ParseError(`tranche ${expectId} arrived as ${id}`);
  const status = str(o, "status");
  const kind = str(o, "kind");
  if (!TRANCHE_STATUSES.includes(status)) throw new ParseError(`unknown tranche status ${status}`);
  if (!KINDS.includes(kind)) throw new ParseError(`unknown tranche kind ${kind}`);
  return {
    milestoneId: expectId,
    kind: kind as TrancheKind,
    bps: int(o, "bps"),
    status: status as TrancheStatus,
    releaseTag: str(o, "release_tag"),
    commitSha: str(o, "commit_sha"),
    artifactDigest: str(o, "artifact_digest"),
    verifiedTs: int(o, "verified_ts"),
    amount: wei(o, "amount"),
  };
}

export function parseVaultState(raw: unknown): VaultState {
  const o = obj(toPlain(raw), "vault");
  const status = str(o, "status");
  if (!VAULT_STATUSES.includes(status)) throw new ParseError(`unknown vault status ${status}`);
  const prefix = str(o, "tag_prefix");
  if (prefix !== "" && prefix !== "v") throw new ParseError("tag_prefix must be '' or 'v'");
  const feeds = arr(o, "feeds");
  if (feeds.length !== 3 || feeds.some((f) => typeof f !== "string")) throw new ParseError("feeds must be three strings");
  const tr = arr(o, "tranches");
  if (tr.length !== 3) throw new ParseError("expected three tranches");
  const vault: VaultState = {
    vaultId: int(o, "vault_id"),
    status: status as VaultStatus,
    funder: str(o, "funder"),
    beneficiary: str(o, "beneficiary"),
    repoUrl: str(o, "repo_url"),
    signerHash: str(o, "signer_hash"),
    tagPrefix: prefix,
    npmPackage: str(o, "npm_package"),
    dockerImage: str(o, "docker_image"),
    feeds: [feeds[0] as string, feeds[1] as string, feeds[2] as string],
    deadline: int(o, "deadline"),
    createdAt: int(o, "created_at"),
    acceptDeadline: int(o, "accept_deadline"),
    acceptedAt: int(o, "accepted_at"),
    deposited: wei(o, "deposited"),
    released: wei(o, "released"),
    withdrawn: wei(o, "withdrawn"),
    reclaimed: wei(o, "reclaimed"),
    withdrawable: wei(o, "withdrawable"),
    unreleased: wei(o, "unreleased"),
    tranchesDone: int(o, "tranches_done"),
    attempts: int(o, "attempts"),
    lastVerdict: int(o, "last_verdict"),
    lastSourceCount: int(o, "last_source_count"),
    lastAttemptAt: int(o, "last_attempt_at"),
    lastMilestone: int(o, "last_milestone"),
    tranches: [parseTranche(tr[0]!, 1), parseTranche(tr[1]!, 2), parseTranche(tr[2]!, 3)],
  };
  if (vault.tranchesDone < 0 || vault.tranchesDone > 3) throw new ParseError("tranches_done out of range");
  if (vault.released > vault.deposited) throw new ParseError("released exceeds deposited");
  return vault;
}

export interface VerifierSource {
  slot: "A" | "B" | "C";
  role: string;
  baseUrl: string;
  host: string;
  operator: string;
}

export interface VerifierSources {
  vaultId: number;
  sources: [VerifierSource, VerifierSource, VerifierSource];
  distinctHosts: number;
  distinctOperators: number;
  independent: boolean;
  quorum: number;
  repoUrl: string;
  signerHash: string;
  npmPackage: string;
  dockerImage: string;
}

export function parseVerifierSources(raw: unknown): VerifierSources {
  const o = obj(toPlain(raw), "verifier sources");
  const rows = arr(o, "sources").map((r) => {
    const s = obj(r, "source");
    const slot = str(s, "slot");
    if (slot !== "A" && slot !== "B" && slot !== "C") throw new ParseError(`bad slot ${slot}`);
    return { slot, role: str(s, "role"), baseUrl: str(s, "base_url"), host: str(s, "host"), operator: str(s, "operator") } as VerifierSource;
  });
  if (rows.length !== 3) throw new ParseError("expected three verifier sources");
  return {
    vaultId: int(o, "vault_id"),
    sources: [rows[0]!, rows[1]!, rows[2]!],
    distinctHosts: int(o, "distinct_hosts"),
    distinctOperators: int(o, "distinct_operators"),
    independent: bool(o, "independent"),
    quorum: int(o, "quorum"),
    repoUrl: str(o, "repo_url"),
    signerHash: str(o, "signer_hash"),
    npmPackage: str(o, "npm_package"),
    dockerImage: str(o, "docker_image"),
  };
}

export interface MilestoneStatus {
  vaultId: number;
  milestoneId: MilestoneId;
  kind: TrancheKind;
  bps: number;
  status: TrancheStatus;
  releaseTag: string;
  commitSha: string;
  artifactDigest: string;
  previousTag: string;
  verifiedTs: number;
  amount: bigint;
  sourceUrls: [string, string, string];
  claimableNow: boolean;
}

export function parseMilestoneStatus(raw: unknown): MilestoneStatus {
  const o = obj(toPlain(raw), "milestone");
  const id = int(o, "milestone_id");
  if (id !== 1 && id !== 2 && id !== 3) throw new ParseError("milestone_id out of range");
  const urls = arr(o, "source_urls");
  if (urls.length !== 3 || urls.some((u) => typeof u !== "string")) throw new ParseError("source_urls must be three strings");
  const status = str(o, "status");
  if (!TRANCHE_STATUSES.includes(status)) throw new ParseError(`unknown tranche status ${status}`);
  const kind = str(o, "kind");
  if (!KINDS.includes(kind)) throw new ParseError(`unknown tranche kind ${kind}`);
  return {
    vaultId: int(o, "vault_id"),
    milestoneId: id,
    kind: kind as TrancheKind,
    bps: int(o, "bps"),
    status: status as TrancheStatus,
    releaseTag: str(o, "release_tag"),
    commitSha: str(o, "commit_sha"),
    artifactDigest: str(o, "artifact_digest"),
    previousTag: str(o, "previous_tag"),
    verifiedTs: int(o, "verified_ts"),
    amount: wei(o, "amount"),
    sourceUrls: [urls[0] as string, urls[1] as string, urls[2] as string],
    claimableNow: bool(o, "claimable_now"),
  };
}

export interface ProtocolState {
  vaultCount: number;
  nextVaultId: number;
  totalEscrow: bigint;
  totalReleased: bigint;
  totalSlashed: bigint;
  totalCancelled: bigint;
  contractBalance: bigint;
  solvent: boolean;
}

export function parseProtocolState(raw: unknown): ProtocolState {
  const o = obj(toPlain(raw), "protocol state");
  return {
    vaultCount: int(o, "vault_count"),
    nextVaultId: int(o, "next_vault_id"),
    totalEscrow: wei(o, "total_escrow"),
    totalReleased: wei(o, "total_released"),
    totalSlashed: wei(o, "total_slashed"),
    totalCancelled: wei(o, "total_cancelled"),
    contractBalance: wei(o, "contract_balance"),
    solvent: bool(o, "solvent"),
  };
}

export interface ClaimResult {
  verdict: 0 | 1 | 2;
  milestoneId: number;
  sourceCount: number;
  releaseTag: string;
  verifiedTs: number;
  released: bigint;
  accepted: boolean;
  commitSha: string;
  artifactDigest: string;
}

/** Decodes the dict `claim_milestone` returns. */
export function parseClaimResult(raw: unknown): ClaimResult {
  const o = obj(toPlain(raw), "claim result");
  const verdict = int(o, "verdict");
  if (verdict !== 0 && verdict !== 1 && verdict !== 2) throw new ParseError(`unknown verdict ${verdict}`);
  return {
    verdict,
    milestoneId: int(o, "milestone_id"),
    sourceCount: int(o, "source_count"),
    releaseTag: str(o, "release_tag"),
    verifiedTs: int(o, "verified_ts"),
    released: wei(o, "released"),
    accepted: bool(o, "accepted"),
    commitSha: str(o, "commit_sha"),
    artifactDigest: str(o, "artifact_digest"),
  };
}
