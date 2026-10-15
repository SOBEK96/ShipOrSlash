"use client";

import { useCallback, useMemo, useState } from "react";
import type { MilestoneStatus, VaultState, VerifierSources } from "@/lib/parse";
import { formatBps, formatGen, formatUtc, shortHash } from "@/lib/format";
import { canonHash, projectPending, type MilestoneId } from "@/lib/protocol";
import { corroborate, probeSource, type SourceReading, type VerifyContext } from "@/lib/verify";
import { Button, Card, Mono, Pill, SemverBadge, type Tone } from "./ui";

const STATUS_TONE: Record<string, Tone> = {
  ACCEPTED: "ship",
  PENDING: "hold",
  LOCKED: "muted",
  SLASHED: "slash",
};

const STATE_TONE: Record<SourceReading["state"], Tone> = {
  CONFIRMED: "ship",
  FAILED: "slash",
  NOT_FOUND: "hold",
  OUTAGE: "muted",
};

const STATE_LABEL: Record<SourceReading["state"], string> = {
  CONFIRMED: "Confirms release",
  FAILED: "Invalid record",
  NOT_FOUND: "Not published yet",
  OUTAGE: "Unreachable",
};

const VERDICT_COPY: Record<number, { tone: Tone; text: string }> = {
  0: { tone: "slash", text: "Rejected: the contract would not release this tranche." },
  1: { tone: "ship", text: "Verified: two or more mirrors corroborate the same signed release." },
  2: { tone: "hold", text: "Retryable: the quorum cannot be reached yet. Nothing is penalised." },
};

/**
 * The tranche ledger and the three-host verifier radar.
 *
 * The radar fetches the three mirror files for the next claimable milestone
 * straight from the browser and shows what each says. That is a preview of the
 * quorum, not the quorum: only the on-chain verdict releases funds.
 */
export function MilestoneTracker({
  vault,
  sources,
  milestones,
}: {
  vault: VaultState | undefined;
  sources: VerifierSources | undefined;
  milestones: Partial<Record<MilestoneId, MilestoneStatus>>;
}) {
  const next = useMemo<MilestoneStatus | undefined>(() => {
    return ([1, 2, 3] as MilestoneId[]).map((m) => milestones[m]).find((m) => m && m.status === "PENDING");
  }, [milestones]);

  const [readings, setReadings] = useState<{ key: string; list: SourceReading[] } | null>(null);
  const [probing, setProbing] = useState(false);

  const probeKey = vault && next ? `${vault.vaultId}:${next.milestoneId}` : null;

  const probe = useCallback(async () => {
    if (!vault || !next || !probeKey) return;
    const ctx: VerifyContext = {
      repo: vault.repoUrl,
      signer: canonHash(vault.signerHash),
      prefix: vault.tagPrefix,
      npm: vault.npmPackage,
      docker: vault.dockerImage,
      milestone: next.milestoneId,
      previousTag: next.previousTag,
      // Builds that already earned an earlier tranche cannot earn this one.
      usedCommits: vault.tranches.filter((t) => t.milestoneId < next.milestoneId && t.commitSha !== "").map((t) => t.commitSha),
      usedDigests: vault.tranches.filter((t) => t.milestoneId < next.milestoneId && t.artifactDigest !== "").map((t) => t.artifactDigest),
    };
    setProbing(true);
    const list: SourceReading[] = [];
    for (const url of next.sourceUrls) list.push(await probeSource(url, ctx));
    setReadings({ key: probeKey, list });
    setProbing(false);
  }, [vault, next, probeKey]);

  if (!vault) {
    return (
      <Card title="Tranche ledger">
        <p className="text-sm text-muted">
          Choose a vault, or create one below. The ledger shows each tranche, the release that unlocked it, and what the
          three verifier mirrors say about the next one.
        </p>
      </Card>
    );
  }

  const current = readings && readings.key === probeKey ? readings.list : null;
  const outcome = current ? corroborate(current) : null;
  // Pending amounts are computed here with the contract's own integer rule
  // (see projectPending), so the ledger never shows a number the contract would
  // not pay. Accepted tranches show the amount the chain recorded.
  const pending = projectPending(vault.deposited, vault.released, vault.tranchesDone);

  return (
    <div className="space-y-4">
      <Card
        title="Tranche ledger"
        aside={
          <Pill tone={vault.status === "ACTIVE" ? "hold" : vault.status === "COMPLETE" ? "ship" : "slash"}>
            {vault.status}
          </Pill>
        }
      >
        <dl className="mb-4 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          <div className="flex gap-2">
            <dt className="text-muted">Repository</dt>
            <dd className="min-w-0 truncate font-mono">{vault.repoUrl.replace("https://", "")}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted">Signer</dt>
            <dd>
              <Mono title={vault.signerHash}>{shortHash(vault.signerHash, 10, 6)}</Mono>
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted">Artifacts</dt>
            <dd className="min-w-0 truncate font-mono">
              {[vault.npmPackage && `npm:${vault.npmPackage}`, vault.dockerImage && `docker:${vault.dockerImage}`]
                .filter(Boolean)
                .join("  ")}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted">Deposited</dt>
            <dd className="font-mono">{formatGen(vault.deposited)} GEN</dd>
          </div>
        </dl>

        <ol className="divide-y divide-line rounded-md border border-line">
          {vault.tranches.map((t, i) => (
            <li key={`${vault.vaultId}:${t.milestoneId}`} className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-1 px-3 py-2.5">
              <span
                aria-hidden
                className={`h-2.5 w-2.5 rounded-full ${
                  t.status === "ACCEPTED" ? "bg-ship" : t.status === "PENDING" ? "bg-hold" : t.status === "SLASHED" ? "bg-slash" : "bg-line"
                }`}
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">
                    Tranche {t.milestoneId} · {t.kind}
                  </span>
                  <Pill tone={STATUS_TONE[t.status] ?? "muted"}>{t.status}</Pill>
                  <SemverBadge tag={t.releaseTag} empty={t.status === "SLASHED" ? "never shipped" : "awaiting release"} />
                </div>
                <p className="text-xs text-muted">
                  {t.status === "ACCEPTED" ? `Verified ${formatUtc(t.verifiedTs)}` : ruleFor(t.milestoneId)}
                </p>
                {t.status === "ACCEPTED" && t.commitSha ? (
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <span>commit</span>
                    <Mono title={t.commitSha}>{t.commitSha.slice(0, 7)}</Mono>
                    <span>artifact</span>
                    <Mono title={t.artifactDigest}>{shortHash(t.artifactDigest, 14, 6)}</Mono>
                  </p>
                ) : null}
              </div>
              <div className="text-right">
                <div className="font-mono text-sm font-semibold">{formatGen(pending[i] ?? t.amount)} GEN</div>
                <div className="text-xs text-muted">{formatBps(t.bps)} of the vault</div>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <Card
        title="Verifier radar"
        aside={
          next ? (
            <Button onClick={() => void probe()} disabled={probing} title="Fetch the three mirror files from your browser">
              {probing ? "Probing mirrors…" : `Probe tranche ${next.milestoneId} mirrors`}
            </Button>
          ) : null
        }
      >
        {sources ? (
          <>
            <ul className="grid gap-3 md:grid-cols-3">
              {sources.sources.map((s, i) => {
                const r = current?.[i];
                return (
                  <li
                    key={s.slot}
                    className={`relative overflow-hidden rounded-md border border-line bg-canvas p-3 ${probing ? "probing" : ""}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs font-semibold text-muted">SLOT {s.slot}</span>
                      {r ? <Pill tone={STATE_TONE[r.state]}>{STATE_LABEL[r.state]}</Pill> : <Pill tone="muted">Not probed</Pill>}
                    </div>
                    <p className="mt-2 truncate font-mono text-[13px] font-semibold" title={s.host}>
                      {s.host}
                    </p>
                    <p className="text-xs text-muted">operator: {s.operator}</p>
                    <p className="mt-1 text-xs text-muted">{s.role}</p>
                    {r ? (
                      <div className="mt-2 space-y-1 border-t border-line pt-2 text-xs">
                        <p>{r.reason}</p>
                        {r.state === "CONFIRMED" ? (
                          <p className="flex flex-wrap items-center gap-1.5">
                            <SemverBadge tag={r.tag} />
                            <Mono title={r.commit}>{r.commit.slice(0, 7)}</Mono>
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-muted">
                Three hostnames, {sources.distinctOperators} operators, quorum {sources.quorum} of 3.{" "}
                {sources.independent ? "Independent." : "NOT independent."}
              </span>
              {outcome ? (
                <span
                  className={`rounded-md border px-2 py-1 ${
                    outcome.verdict === 1
                      ? "border-ship/40 bg-ship-soft text-[#116329]"
                      : outcome.verdict === 0
                        ? "border-slash/40 bg-slash-soft text-[#a40e26]"
                        : "border-hold/50 bg-hold-soft text-hold-ink"
                  }`}
                >
                  Preview: {VERDICT_COPY[outcome.verdict]?.text} ({outcome.sourceCount} answered)
                  {outcome.conflict ? " Mirrors disagree on the release identity (tag, commit, registry or artifact digest)." : ""}
                </span>
              ) : next ? (
                <span className="text-muted">Probe the mirrors to preview the quorum for tranche {next.milestoneId}.</span>
              ) : (
                <span className="text-muted">No tranche is waiting for verification.</span>
              )}
            </div>
            {vault.attempts > 0 ? (
              <p className="mt-2 text-xs text-muted">
                Last on-chain attempt: tranche {vault.lastMilestone}, {VERDICT_NAME[vault.lastVerdict] ?? "unknown"},{" "}
                {vault.lastSourceCount} of 3 mirrors answered ({vault.attempts} attempt{vault.attempts === 1 ? "" : "s"} so far).
              </p>
            ) : null}
            <p className="mt-2 text-xs text-muted">
              The preview is your browser&apos;s own reading of the mirrors. Only the on-chain verdict moves funds.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted">Verifier sources have not loaded yet.</p>
        )}
      </Card>
    </div>
  );
}

const VERDICT_NAME: Record<number, string> = { 0: "rejected", 1: "verified", 2: "retryable (quorum not reached)" };

function ruleFor(m: number): string {
  if (m === 1) return "Needs a signed -alpha or -beta SemVer release with passing CI.";
  if (m === 2) return "Needs a signed -rc SemVer release newer than tranche 1.";
  return "Needs a signed stable release, 1.0.0 or later, newer than tranche 2.";
}
