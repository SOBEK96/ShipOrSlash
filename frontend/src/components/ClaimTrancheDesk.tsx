"use client";

import { useState } from "react";
import type { MilestoneStatus, VaultState } from "@/lib/parse";
import { formatDuration, formatGen, formatUtc, parseGen } from "@/lib/format";
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
  onAccept,
  onReject,
  onCancel,
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
  onAccept: () => void;
  onReject: () => void;
  onCancel: () => void;
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

  // A vault that has not been accepted (or that ended without being accepted) is
  // an offer, not a vault to claim from: show the terms and the way out.
  if (vault.status === "PENDING_ACCEPTANCE" || vault.status === "REJECTED" || vault.status === "CANCELLED") {
    return (
      <TermsDesk
        vault={vault}
        role={role}
        connected={connected}
        busy={busy}
        notice={notice}
        nowSeconds={nowSeconds}
        onAccept={onAccept}
        onReject={onReject}
        onCancel={onCancel}
        onDismiss={onDismiss}
      />
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

function NoticeBar({ notice, onDismiss }: { notice: TxNotice | null; onDismiss: () => void }) {
  if (!notice) return null;
  return (
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
  );
}

/**
 * The desk for a vault that is still an offer. The funder chose the registry and
 * the three verifier mirrors, so nothing can be claimed until the beneficiary
 * has inspected them and accepted; if they reject or ignore it, the funder gets
 * the whole principal back.
 */
function TermsDesk({
  vault,
  role,
  connected,
  busy,
  notice,
  nowSeconds,
  onAccept,
  onReject,
  onCancel,
  onDismiss,
}: {
  vault: VaultState;
  role: Role;
  connected: boolean;
  busy: string | null;
  notice: TxNotice | null;
  nowSeconds: number;
  onAccept: () => void;
  onReject: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const pending = vault.status === "PENDING_ACCEPTANCE";
  // The contract's boundary: acceptance is allowed up to and including
  // acceptDeadline; cancelling is allowed strictly after it.
  const lapsed = nowSeconds > vault.acceptDeadline;
  const free = connected && busy === null;
  const canAccept = free && role === "beneficiary" && pending && !lapsed;
  const canReject = free && role === "beneficiary" && pending;
  const canCancel = free && role === "funder" && (vault.status === "REJECTED" || (pending && lapsed));
  const principal = `${formatGen(vault.deposited)} GEN`;

  return (
    <Card title="Vault terms" aside={<Pill tone={pending ? "hold" : "slash"}>{vault.status.replace("_", " ")}</Pill>}>
      <div className="space-y-4">
        {pending ? (
          <>
            <p className="rounded-md border border-hold/50 bg-hold-soft px-3 py-2 text-sm text-hold-ink">
              {lapsed
                ? "The acceptance window has closed without acceptance."
                : `Acceptance window: ${formatDuration(vault.acceptDeadline - nowSeconds)} left.`}{" "}
              Nothing can be claimed until the beneficiary accepts.
            </p>

            {role === "beneficiary" ? (
              <div className="space-y-2 text-sm">
                <p className="font-semibold">Inspect before you accept</p>
                <ul className="list-disc space-y-1 pl-5 text-muted">
                  <li>The repository and the signer fingerprint hash are the ones you ship and sign with.</li>
                  <li>The package targets are the ones you publish to.</li>
                  <li>
                    All three verifier mirrors (listed in the verifier radar) are on hosts and operators you trust, are
                    not run by the funder, and serve commit-pinned, immutable files. The funder chose them, and the
                    contract cannot tell whether a host is under the funder&apos;s control.
                  </li>
                </ul>
                <p className="text-muted">
                  Once you accept, the registry is binding: the funder can slash every tranche you have not shipped by the
                  deadline ({formatUtc(vault.deadline)}).
                </p>
              </div>
            ) : role === "funder" ? (
              <p className="text-sm text-muted">
                Waiting for the beneficiary. You cannot cancel while the window is open: they are owed the full time to
                inspect the mirrors. If they reject, or the window lapses, you can cancel and recover the whole {principal}.
              </p>
            ) : (
              <p className="text-sm text-muted">
                Only the beneficiary can accept this vault and only the funder can cancel it.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button tone="primary" disabled={!canAccept} onClick={onAccept}>
                Accept terms
              </Button>
              <Button tone="danger" disabled={!canReject} onClick={onReject}>
                Reject terms
              </Button>
              <Button tone="danger" disabled={!canCancel} onClick={onCancel} title="Available once the window lapses">
                Cancel and recover {principal}
              </Button>
            </div>
          </>
        ) : vault.status === "REJECTED" ? (
          <>
            <p className="text-sm text-muted">
              The beneficiary rejected these terms.{" "}
              {role === "funder" ? `Cancel to recover the whole ${principal}.` : `The funder can now cancel and recover the whole ${principal}.`}
            </p>
            <Button tone="danger" disabled={!canCancel} onClick={onCancel}>
              Cancel and recover {principal}
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted">
            This vault was cancelled before it was accepted. The full {principal} was returned to the funder; no tranche was
            ever released.
          </p>
        )}
        {!connected ? <p className="text-xs text-muted">Connect a wallet to act on this vault.</p> : null}
        <NoticeBar notice={notice} onDismiss={onDismiss} />
      </div>
    </Card>
  );
}

