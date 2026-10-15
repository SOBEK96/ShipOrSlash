"use client";

import { useEffect, useState } from "react";
import { ClaimTrancheDesk } from "@/components/ClaimTrancheDesk";
import { Footer } from "@/components/Footer";
import { MilestoneTracker } from "@/components/MilestoneTracker";
import { ProtocolExplainer } from "@/components/ProtocolExplainer";
import { SyncAlert } from "@/components/SyncAlert";
import { VaultCreator } from "@/components/VaultCreator";
import { Button, Pill } from "@/components/ui";
import { formatGen, shortHash } from "@/lib/format";
import { DEFAULT_NETWORK } from "@/lib/networks";
import { useConsole } from "@/lib/useConsole";

/** Wall-clock seconds, ticking every 15s. Isolated so only consumers re-render. */
function useNowSeconds(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export default function Home() {
  const c = useConsole();
  const now = useNowSeconds();
  const vaultCount = c.protocol?.vaultCount ?? 0;

  return (
    <div className="min-h-screen">
      <header className="bg-ink text-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-base font-semibold tracking-tight">ShipOrSlash</span>
            <span className="hidden text-xs text-white/70 sm:inline">Vesting that unlocks on shipped code</span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Pill tone="link">{DEFAULT_NETWORK.label}</Pill>
            {c.account ? (
              <>
                <span className="rounded-md border border-white/25 px-2 py-1 font-mono text-xs" title={c.account}>
                  {shortHash(c.account, 6, 4)}
                </span>
                <button type="button" className="text-xs text-white/70 hover:text-white" onClick={c.disconnect}>
                  Disconnect
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void c.connect()}
                className="rounded-md border border-white/40 px-3 py-1 text-sm font-medium hover:bg-white/10"
              >
                Connect wallet
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        <div className="space-y-3">
          <SyncAlert sync={c.sync} now={now * 1000} onRetry={() => void c.refresh()} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label htmlFor="vault" className="font-semibold">
                Vault
              </label>
              <select
                id="vault"
                className="rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-sm"
                value={c.vaultId ?? ""}
                onChange={(e) => c.selectVault(e.target.value === "" ? null : Number(e.target.value))}
              >
                <option value="">{vaultCount === 0 ? "No vaults yet" : "Select a vault…"}</option>
                {Array.from({ length: vaultCount }, (_, i) => i + 1).map((id) => (
                  <option key={id} value={id}>
                    #{id}
                  </option>
                ))}
              </select>
              <Button onClick={() => void c.refresh()}>Refresh</Button>
            </div>
            {c.protocol ? (
              <p className="text-xs text-muted">
                {c.protocol.vaultCount} vault{c.protocol.vaultCount === 1 ? "" : "s"} ·{" "}
                <span className="font-mono">{formatGen(c.protocol.totalEscrow)}</span> GEN in escrow ·{" "}
                <span className="font-mono">{formatGen(c.protocol.totalReleased)}</span> released ·{" "}
                <span className="font-mono">{formatGen(c.protocol.totalSlashed)}</span> slashed
              </p>
            ) : null}
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <MilestoneTracker key={`tracker-${c.vaultId ?? "none"}`} vault={c.data.vault} sources={c.data.sources} milestones={c.data.milestones} />
          <ClaimTrancheDesk
            key={`desk-${c.vaultId ?? "none"}`}
            vault={c.data.vault}
            milestones={c.data.milestones}
            role={c.role}
            connected={c.account !== null}
            busy={c.busy}
            notice={c.notice}
            nowSeconds={now}
            onClaim={(m) => void c.claim(m)}
            onWithdraw={() => void c.withdraw()}
            onReclaim={() => void c.reclaim()}
            onTopUp={(w) => void c.topUp(w)}
            onDismiss={c.dismissNotice}
          />
        </div>

        <VaultCreator account={c.account} busy={c.busy} onCreate={(i) => void c.createVault(i)} />
        <ProtocolExplainer />
      </main>
      <Footer />
    </div>
  );
}
