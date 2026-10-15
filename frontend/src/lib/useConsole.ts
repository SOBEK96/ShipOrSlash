"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ShipOrSlashClient, injectedProvider, type CreateVaultInput } from "./contract";
import { ReceiptError } from "./receipt";
import { canonHash } from "./protocol";
import type { MilestoneStatus, ProtocolState, VaultState, VerifierSources } from "./parse";
import type { MilestoneId } from "./protocol";
import { MonotoneClock } from "./serialLoader";

export interface VaultData {
  vault?: VaultState;
  sources?: VerifierSources;
  milestones: Partial<Record<MilestoneId, MilestoneStatus>>;
}

export interface SyncStatus {
  /** "idle" before the first read, "syncing" while loading, "ok", "partial" or "down". */
  phase: "idle" | "syncing" | "ok" | "partial" | "down";
  lastSyncedAt: number | null;
  /** Items whose latest read failed (they keep their last good value). */
  failedItems: string[];
  error: string | null;
}

export interface TxNotice {
  kind: "info" | "success" | "error";
  message: string;
  hash?: string;
}

const VAULT_ITEMS = ["vault", "sources", "m1", "m2", "m3"] as const;
const MS_KEYS: Record<string, MilestoneId> = { m1: 1, m2: 2, m3: 3 };

function describeError(e: unknown): string {
  if (e instanceof ReceiptError) return e.message;
  if (e instanceof Error) return e.message.split("\n")[0] ?? e.message;
  return String(e);
}

export function useConsole() {
  const [client] = useState(() => new ShipOrSlashClient());
  const clock = useRef(new MonotoneClock());
  const [account, setAccount] = useState<string | null>(null);
  const [vaultId, setVaultId] = useState<number | null>(null);
  const [protocol, setProtocol] = useState<ProtocolState | null>(null);
  const [data, setData] = useState<VaultData>({ milestones: {} });
  const [sync, setSync] = useState<SyncStatus>({ phase: "idle", lastSyncedAt: null, failedItems: [], error: null });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<TxNotice | null>(null);
  const epoch = useRef(0);

  // Keep React's view of the account in step with the client's scoped store.
  useEffect(() => {
    return client.accounts.subscribe(() => {
      setAccount(client.accounts.current);
    });
  }, [client]);

  const refresh = useCallback(
    async (id: number | null = vaultId) => {
      const mine = ++epoch.current;
      setSync((s) => ({ ...s, phase: "syncing" }));
      let proto: ProtocolState | null = null;
      let protoError: string | null = null;
      try {
        proto = await client.protocolState();
      } catch (e) {
        protoError = describeError(e);
      }
      if (mine !== epoch.current) return;
      if (proto) setProtocol(proto);

      if (id === null) {
        setSync({
          phase: proto ? "ok" : "down",
          lastSyncedAt: proto ? clock.current.now() : null,
          failedItems: proto ? [] : ["protocol"],
          error: protoError,
        });
        return;
      }

      const loader = client.vaultLoader(id);
      await loader.load([...VAULT_ITEMS]);
      if (mine !== epoch.current) return;

      const next: VaultData = { milestones: {} };
      next.vault = loader.value("vault") as VaultState | undefined;
      next.sources = loader.value("sources") as VerifierSources | undefined;
      for (const [k, m] of Object.entries(MS_KEYS)) {
        const v = loader.value(k) as MilestoneStatus | undefined;
        if (v) next.milestones[m] = v;
      }
      const failed = loader.failedKeys();
      if (protoError) failed.push("protocol");
      // Retention across refreshes: an item that failed this time keeps the
      // value we already had, rather than blanking the panel.
      setData((prev) => ({
        vault: next.vault ?? prev.vault,
        sources: next.sources ?? prev.sources,
        milestones: { ...prev.milestones, ...next.milestones },
      }));
      const everything = failed.length >= VAULT_ITEMS.length;
      setSync({
        phase: failed.length === 0 ? "ok" : everything ? "down" : "partial",
        lastSyncedAt: failed.length === 0 || !everything ? clock.current.now() : null,
        failedItems: failed,
        error: protoError ?? loader.failedKeys().map((k) => loader.get(k)?.error).find(Boolean) ?? null,
      });
    },
    [client, vaultId],
  );

  // Initial and periodic sync. refresh() sets state only after awaiting I/O.
  useEffect(() => {
    void refresh(vaultId);
    const t = setInterval(() => void refresh(vaultId), 20_000);
    return () => clearInterval(t);
  }, [refresh, vaultId]);

  const selectVault = useCallback((id: number | null) => {
    epoch.current += 1; // invalidate any in-flight read for the previous vault
    setData({ milestones: {} });
    setVaultId(id);
  }, []);

  const connect = useCallback(async () => {
    const provider = injectedProvider();
    if (!provider) {
      setNotice({ kind: "error", message: "No wallet found. Install an EIP-1193 wallet such as MetaMask." });
      return;
    }
    try {
      await client.connect(provider);
    } catch (e) {
      setNotice({ kind: "error", message: describeError(e) });
    }
  }, [client]);

  const disconnect = useCallback(() => client.disconnect(), [client]);

  const run = useCallback(
    async (label: string, work: () => Promise<{ hash: string }>, done: string, then?: () => void) => {
      const forAccount = client.accounts.current;
      setBusy(label);
      setNotice({ kind: "info", message: `${label}… waiting for the network to decide.` });
      try {
        const { hash } = await work();
        // A wallet switch mid-flight must not report success under the new account.
        if (client.accounts.current !== forAccount) {
          setNotice({ kind: "info", message: "Wallet changed while the transaction was pending. Check the explorer.", hash });
        } else {
          setNotice({ kind: "success", message: done, hash });
          then?.();
        }
        await refresh(vaultId);
      } catch (e) {
        setNotice({ kind: "error", message: describeError(e) });
      } finally {
        setBusy(null);
      }
    },
    [client, refresh, vaultId],
  );

  const createVault = useCallback(
    (input: CreateVaultInput) =>
      run("Creating vault", () => client.createVault(input), "Vault created.", () => {
        void client.protocolState().then((p) => {
          setProtocol(p);
          setVaultId(p.vaultCount);
        });
      }),
    [client, run],
  );

  const claim = useCallback(
    (milestone: MilestoneId) => {
      if (vaultId === null) return Promise.resolve();
      return run(`Verifying tranche ${milestone}`, () => client.claimMilestone(vaultId, milestone), "Verification decided. Check the tranche ledger for the verdict.");
    },
    [client, run, vaultId],
  );

  const withdraw = useCallback(() => {
    if (vaultId === null) return Promise.resolve();
    return run("Withdrawing", () => client.withdrawReleased(vaultId), "Withdrawal sent.");
  }, [client, run, vaultId]);

  const reclaim = useCallback(() => {
    if (vaultId === null) return Promise.resolve();
    return run("Slashing unshipped tranches", () => client.reclaimUnreleased(vaultId), "Unshipped tranches returned to the funder.");
  }, [client, run, vaultId]);

  const topUp = useCallback(
    (wei: bigint) => {
      if (vaultId === null) return Promise.resolve();
      return run("Topping up", () => client.topUpVault(vaultId, wei), "Vault topped up.");
    },
    [client, run, vaultId],
  );

  const role = useMemo(() => {
    const v = data.vault;
    if (!v || !account) return "viewer" as const;
    if (account === v.beneficiary.toLowerCase()) return "beneficiary" as const;
    if (account === v.funder.toLowerCase()) return "funder" as const;
    return "viewer" as const;
  }, [account, data.vault]);

  const signer = useMemo(() => {
    const v = data.vault;
    return v ? canonHash(v.signerHash) : "";
  }, [data.vault]);

  return {
    client,
    account,
    vaultId,
    protocol,
    data,
    sync,
    busy,
    notice,
    role,
    signerHash: signer,
    dismissNotice: () => setNotice(null),
    refresh: () => refresh(vaultId),
    selectVault,
    connect,
    disconnect,
    createVault,
    claim,
    withdraw,
    reclaim,
    topUp,
  };
}
