"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ShipOrSlashClient, injectedProvider, type CreateVaultInput } from "./contract";
import { SingleFlight } from "./coalesce";
import type { MilestoneStatus, ProtocolState, VaultState, VerifierSources } from "./parse";
import { canonHash, type MilestoneId } from "./protocol";
import { ReceiptError } from "./receipt";
import { MonotoneClock, type SerialLoader } from "./serialLoader";
import { emptySlice, putSlice, sliceFor, type SliceStore, type VaultSlice } from "./vaultSlice";

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
const POLL_MS = 20_000;
const IDLE: SyncStatus = { phase: "idle", lastSyncedAt: null, failedItems: [], error: null };

function describeError(e: unknown): string {
  if (e instanceof ReceiptError) return e.message;
  if (e instanceof Error) return e.message.split("\n")[0] ?? e.message;
  return String(e);
}

/**
 * Console state. The two rules that matter:
 *
 *  1. Per-vault data lives in `slices[vault_id]` and nowhere else. Every read
 *     writes only to the slice of the vault it was started for, and the panels
 *     render `sliceFor(slices, selected)`, which refuses anything whose own
 *     vault_id disagrees. Switching vaults, or a transaction finishing for a
 *     vault that is no longer selected, cannot put one vault's numbers under
 *     another's name.
 *  2. Reads for a vault go through one SingleFlight. Polling never overlaps or
 *     invalidates a slow read; an explicit refresh queues at most one
 *     follow-up.
 */
export function useConsole() {
  const [client] = useState(() => new ShipOrSlashClient());
  const clock = useRef(new MonotoneClock());
  const [account, setAccount] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [protocol, setProtocol] = useState<ProtocolState | null>(null);
  const [protocolSync, setProtocolSync] = useState<SyncStatus>(IDLE);
  const [slices, setSlices] = useState<SliceStore>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<TxNotice | null>(null);

  // One loader and one flight per vault id, created on first use.
  const loaders = useRef(new Map<number, SerialLoader<string, unknown>>());
  const flights = useRef(new Map<number, SingleFlight<void>>());
  const protocolFlight = useRef<SingleFlight<void> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const unsub = client.accounts.subscribe(() => setAccount(client.accounts.current));
    return () => {
      mounted.current = false;
      unsub();
    };
  }, [client]);

  const readProtocol = useCallback(async (): Promise<string | null> => {
    try {
      const p = await client.protocolState();
      if (mounted.current) setProtocol(p);
      return null;
    } catch (e) {
      return describeError(e);
    }
  }, [client]);

  const readVault = useCallback(
    async (id: number): Promise<void> => {
      let loader = loaders.current.get(id);
      if (!loader) {
        loader = client.vaultLoader(id);
        loaders.current.set(id, loader);
      }
      const protoError = await readProtocol();
      await loader.load([...VAULT_ITEMS]);
      if (!mounted.current) return;

      const slice: VaultSlice = emptySlice(id);
      slice.vault = loader.value("vault") as VaultState | undefined;
      slice.sources = loader.value("sources") as VerifierSources | undefined;
      for (const m of [1, 2, 3] as MilestoneId[]) {
        const v = loader.value(`m${m}`) as MilestoneStatus | undefined;
        if (v) slice.milestones[m] = v;
      }
      const failed = loader.failedKeys();
      if (protoError) failed.push("protocol");
      slice.failedItems = failed;
      slice.error =
        protoError ??
        loader
          .failedKeys()
          .map((k) => loader.get(k)?.error)
          .find((e): e is string => typeof e === "string") ??
        null;
      slice.syncedAt = failed.length >= VAULT_ITEMS.length ? null : clock.current.now();
      // Writes only to this vault's own key.
      setSlices((prev) => putSlice(prev, slice));
    },
    [client, readProtocol],
  );

  const flightFor = useCallback(
    (id: number): SingleFlight<void> => {
      let f = flights.current.get(id);
      if (!f) {
        f = new SingleFlight<void>(() => readVault(id));
        flights.current.set(id, f);
      }
      return f;
    },
    [readVault],
  );

  const readProtocolOnly = useCallback(async () => {
    const err = await readProtocol();
    if (!mounted.current) return;
    setProtocolSync({
      phase: err ? "down" : "ok",
      lastSyncedAt: err ? null : clock.current.now(),
      failedItems: err ? ["protocol"] : [],
      error: err,
    });
  }, [readProtocol]);

  const protocolFlightFor = useCallback((): SingleFlight<void> => {
    if (!protocolFlight.current) protocolFlight.current = new SingleFlight<void>(readProtocolOnly);
    return protocolFlight.current;
  }, [readProtocolOnly]);

  // Polling for the selected vault (or protocol totals when none is selected).
  // The next tick is scheduled only after the previous read settles, so a slow
  // RPC stretches the cadence instead of stacking requests.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const flight = selected === null ? protocolFlightFor() : flightFor(selected);
    const tick = async () => {
      try {
        await flight.poll();
      } catch {
        /* surfaced through the slice / protocol sync */
      }
      if (!cancelled) timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [selected, flightFor, protocolFlightFor]);

  const refresh = useCallback(
    (id: number | null = selected) =>
      (id === null ? protocolFlightFor() : flightFor(id)).request().catch(() => undefined),
    [selected, flightFor, protocolFlightFor],
  );

  const selectVault = useCallback((id: number | null) => setSelected(id), []);

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

  /**
   * Runs a write for `vaultId` -- the vault the user acted on, passed in
   * explicitly rather than read from the selection when the transaction
   * resolves. The follow-up refresh therefore targets that vault's own slice.
   */
  const run = useCallback(
    async (
      label: string,
      vaultId: number | null,
      work: () => Promise<{ hash: string }>,
      done: string,
      then?: () => void,
    ) => {
      const forAccount = client.accounts.current;
      setBusy(label);
      setNotice({ kind: "info", message: `${label}… waiting for the network to decide.` });
      try {
        const { hash } = await work();
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
    [client, refresh],
  );

  const createVault = useCallback(
    (input: CreateVaultInput) =>
      run("Creating vault", null, () => client.createVault(input), "Vault created.", () => {
        void client.protocolState().then((p) => {
          setProtocol(p);
          setSelected(p.vaultCount);
        });
      }),
    [client, run],
  );

  const claim = useCallback(
    (milestone: MilestoneId) => {
      if (selected === null) return Promise.resolve();
      const id = selected;
      return run(
        `Verifying tranche ${milestone}`,
        id,
        () => client.claimMilestone(id, milestone),
        "Verification decided. Check the tranche ledger for the verdict.",
      );
    },
    [client, run, selected],
  );

  const withdraw = useCallback(() => {
    if (selected === null) return Promise.resolve();
    const id = selected;
    return run("Withdrawing", id, () => client.withdrawReleased(id), "Withdrawal sent.");
  }, [client, run, selected]);

  const reclaim = useCallback(() => {
    if (selected === null) return Promise.resolve();
    const id = selected;
    return run("Slashing unshipped tranches", id, () => client.reclaimUnreleased(id), "Unshipped tranches returned to the funder.");
  }, [client, run, selected]);

  const topUp = useCallback(
    (wei: bigint) => {
      if (selected === null) return Promise.resolve();
      const id = selected;
      return run("Topping up", id, () => client.topUpVault(id, wei), "Vault topped up.");
    },
    [client, run, selected],
  );

  // What the panels render: the selected vault's slice, id-verified.
  const slice = useMemo(() => sliceFor(slices, selected), [slices, selected]);

  const sync: SyncStatus = useMemo(() => {
    if (selected === null) return protocolSync;
    if (!slice || (slice.syncedAt === null && slice.failedItems.length === 0 && !slice.vault)) {
      return slice ? { phase: "down", lastSyncedAt: null, failedItems: slice.failedItems, error: slice.error } : { ...IDLE, phase: "syncing" };
    }
    const failed = slice.failedItems;
    const all = failed.length >= VAULT_ITEMS.length;
    return {
      phase: failed.length === 0 ? "ok" : all ? "down" : "partial",
      lastSyncedAt: slice.syncedAt,
      failedItems: failed,
      error: slice.error,
    };
  }, [selected, slice, protocolSync]);

  const role = useMemo(() => {
    const v = slice?.vault;
    if (!v || !account) return "viewer" as const;
    if (account === v.beneficiary.toLowerCase()) return "beneficiary" as const;
    if (account === v.funder.toLowerCase()) return "funder" as const;
    return "viewer" as const;
  }, [account, slice]);

  return {
    client,
    account,
    vaultId: selected,
    protocol,
    data: {
      vault: slice?.vault,
      sources: slice?.sources,
      milestones: slice?.milestones ?? {},
    },
    sync,
    busy,
    notice,
    role,
    signerHash: slice?.vault ? canonHash(slice.vault.signerHash) : "",
    dismissNotice: () => setNotice(null),
    refresh: () => refresh(selected),
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
