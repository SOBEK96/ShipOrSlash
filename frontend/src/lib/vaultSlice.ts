/**
 * Per-vault view state, keyed by vault_id.
 *
 * Everything a vault panel renders lives in one slice that carries the id it
 * was loaded for. `sliceFor` hands a component data only when that id equals
 * the vault being shown, and drops any member (a milestone, the verifier
 * sources) whose own vault_id disagrees. A response for vault 1 can therefore
 * never be rendered as vault 2, whichever order requests complete in.
 */

import type { MilestoneStatus, VaultState, VerifierSources } from "./parse";
import type { MilestoneId } from "./protocol";

export interface VaultSlice {
  vaultId: number;
  vault?: VaultState;
  sources?: VerifierSources;
  milestones: Partial<Record<MilestoneId, MilestoneStatus>>;
  /** Items whose latest read failed; they keep their last good value. */
  failedItems: string[];
  error: string | null;
  /** Monotone ticket of the read that produced this slice. */
  syncedAt: number | null;
}

export type SliceStore = Readonly<Record<number, VaultSlice | undefined>>;

export function emptySlice(vaultId: number): VaultSlice {
  return { vaultId, milestones: {}, failedItems: [], error: null, syncedAt: null };
}

/** The slice for `selected`, with every member verified to belong to it. */
export function sliceFor(store: SliceStore, selected: number | null): VaultSlice | undefined {
  if (selected === null) return undefined;
  const s = store[selected];
  if (!s || s.vaultId !== selected) return undefined;
  const milestones: Partial<Record<MilestoneId, MilestoneStatus>> = {};
  for (const m of [1, 2, 3] as MilestoneId[]) {
    const ms = s.milestones[m];
    if (ms && ms.vaultId === selected && ms.milestoneId === m) milestones[m] = ms;
  }
  return {
    ...s,
    vault: s.vault && s.vault.vaultId === selected ? s.vault : undefined,
    sources: s.sources && s.sources.vaultId === selected ? s.sources : undefined,
    milestones,
  };
}

/** Writes `next` under its own id. Never touches any other vault's slice, and a
 * slice with an older ticket never replaces a newer one. */
export function putSlice(store: SliceStore, next: VaultSlice): SliceStore {
  const cur = store[next.vaultId];
  if (cur && cur.syncedAt !== null && next.syncedAt !== null && next.syncedAt < cur.syncedAt) {
    return store;
  }
  return { ...store, [next.vaultId]: next };
}
