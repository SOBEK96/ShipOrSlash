"use client";

import { useState } from "react";
import type { MilestoneStatus, VaultState } from "@/lib/parse";
import { formatDuration, formatGen, parseGen } from "@/lib/format";
import { MIN_DEPOSIT, nextReleaseAmount, type MilestoneId } from "@/lib/protocol";
import type { TxNotice } from "@/lib/useConsole";
import { explorerTxUrl, DEFAULT_NETWORK } from "@/lib/networks";
import { Button, Card, Field, Pill, inputClass } from "./ui";

type Role = "viewer" | "funder" | "beneficiary";

const ROLE_COPY: Record<Role, string> = {
  viewer: "You are viewing this vault. Only its funder or beneficiary can act on it.",
  funder: "You funded this vault. You can verify tranches, top it up, and slash what is not shipped after the deadline.",
  beneficiary: "You are this vault's beneficiary. You can verify tranches and withdraw what has been released.",
};

export function ClaimTrancheDesk({
  vault,
  milestones,
  role,
  connected,
  busy,
  notice,
  nowSeconds,
  onClaim,
  onWithdraw,
  onReclaim,
  onTopUp,
  onDismiss,
}: {
  vault: VaultState | undefined;
  milestones: Partial<Record<MilestoneId, MilestoneStatus>>;
  role: Role;
  connected: boolean;
  busy: string | null;
  notice: TxNotice | null;
  nowSeconds: number;
  onClaim: (m: MilestoneId) => void;
  onWithdraw: () => void;
  onReclaim: () => void;
  onTopUp: (wei: bigint) => void;
  onDismiss: () => void;
}) {
  const [topUp, setTopUp] = useState("");

  if (!vault) {
    return (
      <Card title="Claim desk">
        <p className="text-sm text-muted">Select a vault to verify a tranche, withdraw released funds or slash.</p>
      </Card>
    );
  }

  const next = ([1, 2, 3] as MilestoneId[])
    .map((m) => milestones[m])
    .find((m) => m?.claimableNow && m.vaultId === vault.vaultId);
  const canAct = connected && (role === "funder" || role === "beneficiary") && busy === null;
  const pastDeadline = nowSeconds >= vault.deadline;
  const topUpWei = parseGen(topUp);
  const topUpError =
    topUp === "" ? null : topUpWei === null ? "Enter an amount like 0.25." : topUpWei < MIN_DEPOSIT ? "Minimum top-up is 0.001 GEN." : null;

  return (
    <Card
      title="Claim desk"
      aside={<Pill tone={role === "viewer" ? "muted" : "link"}>{role === "viewer" ? "viewer" : role}</Pill>}
    >
      <p className="mb-4 text-xs text-muted">{connected ? ROLE_COPY[role] : "Connect a wallet to act on this vault."}</p>

      <div className="space-y-4">
        <div className="rounded-md border border-line bg-canvas p-3">
          {next ? (
            <>
              <p className="text-sm">
                Next: <strong>tranche {next.milestoneId}</strong> ({next.kind}), worth{" "}
                <span className="font-mono font-semibold">
                  {formatGen(nextReleaseAmount(vault.deposited, vault.released, next.milestoneId))} GEN
                </span>
                .
              </p>
              <p className="mt-1 text-xs text-muted">
                Verification reads three mirror files on three hosts. It costs a network fee even if the answer is
                &ldquo;not yet&rdquo;; a retryable outcome changes nothing else.
              </p>
              <div className="mt-3">
                <Button tone="primary" disabled={!canAct} onClick={() => onClaim(next.milestoneId)}>
                  {busy?.startsWith("Verifying") ? busy + "…" : `Verify tranche ${next.milestoneId}`}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted">
              {vault.status === "COMPLETE"
                ? "All three tranches are released."
                : vault.status === "SLASHED"
                  ? "This vault was slashed. Nothing more can be verified."
                  : "No tranche is waiting."}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line p-3">
          <div>
            <p className="text-xs text-muted">Released and withdrawable</p>
            <p className="font-mono text-base font-semibold">{formatGen(vault.withdrawable)} GEN</p>
          </div>
          <Button
            disabled={!(connected && role === "beneficiary") || vault.withdrawable === 0n || busy !== null}
            onClick={onWithdraw}
            title={role === "beneficiary" ? "Pull released funds to your wallet" : "Only the beneficiary can withdraw"}
          >
            Withdraw
          </Button>
        </div>

        <div className="rounded-md border border-line p-3">
          <p className="text-xs text-muted">Unreleased, still in escrow</p>
          <p className="font-mono text-base font-semibold">{formatGen(vault.unreleased)} GEN</p>
          <p className="mt-1 text-xs text-muted">
            {vault.status !== "ACTIVE"
              ? "Vault closed."
              : pastDeadline
                ? "The deadline has passed. The funder may slash everything not yet shipped."
                : `Deadline in ${formatDuration(vault.deadline - nowSeconds)}. Until then unshipped tranches stay locked.`}
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <Button
              tone="danger"
              disabled={!(connected && role === "funder") || vault.status !== "ACTIVE" || !pastDeadline || busy !== null}
              onClick={onReclaim}
            >
              Slash unshipped tranches
            </Button>
            {role === "funder" && vault.status === "ACTIVE" ? (
              <div className="flex items-end gap-2">
                <Field label="Top up (GEN)" error={topUpError}>
                  <input
                    className={`${inputClass} w-28`}
                    inputMode="decimal"
                    placeholder="0.25"
                    value={topUp}
                    onChange={(e) => setTopUp(e.target.value)}
                  />
                </Field>
                <Button
                  disabled={!connected || topUpWei === null || topUpError !== null || busy !== null}
                  onClick={() => {
                    if (topUpWei !== null) onTopUp(topUpWei);
                    setTopUp("");
                  }}
                >
                  Top up
                </Button>
              </div>
            ) : null}
          </div>
        </div>

        {notice ? (
          <div
            role="status"
            className={`flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm ${
              notice.kind === "success"
                ? "border-ship/40 bg-ship-soft text-[#116329]"
                : notice.kind === "error"
                  ? "border-slash/40 bg-slash-soft text-[#a40e26]"
                  : "border-line bg-canvas text-ink"
            }`}
          >
            <span>
              {notice.message}
              {notice.hash ? (
                <>
                  {" "}
                  <a href={explorerTxUrl(DEFAULT_NETWORK, notice.hash)} target="_blank" rel="noreferrer">
                    View transaction
                  </a>
                </>
              ) : null}
            </span>
            <button type="button" aria-label="Dismiss" className="text-muted hover:text-ink" onClick={onDismiss}>
              ×
            </button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
