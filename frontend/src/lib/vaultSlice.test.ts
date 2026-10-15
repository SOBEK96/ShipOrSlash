import { describe, expect, it } from "vitest";
import type { MilestoneStatus, VaultState, VerifierSources } from "./parse";
import { emptySlice, putSlice, sliceFor, type SliceStore } from "./vaultSlice";

const vault = (id: number): VaultState => ({ vaultId: id } as VaultState);
const sources = (id: number): VerifierSources => ({ vaultId: id } as VerifierSources);
const ms = (id: number, m: 1 | 2 | 3): MilestoneStatus => ({ vaultId: id, milestoneId: m } as MilestoneStatus);

describe("sliceFor", () => {
  it("returns nothing for no selection or an unknown vault", () => {
    expect(sliceFor({}, null)).toBeUndefined();
    expect(sliceFor({}, 3)).toBeUndefined();
  });

  it("returns the selected vault's data", () => {
    const store: SliceStore = {
      1: { ...emptySlice(1), vault: vault(1), sources: sources(1), milestones: { 1: ms(1, 1) } },
    };
    const s = sliceFor(store, 1)!;
    expect(s.vault?.vaultId).toBe(1);
    expect(s.milestones[1]?.vaultId).toBe(1);
  });

  it("refuses a slice filed under the wrong key", () => {
    const store: SliceStore = { 2: { ...emptySlice(1), vault: vault(1) } };
    expect(sliceFor(store, 2)).toBeUndefined();
  });

  it("drops a vault, sources or milestone that belongs to another vault", () => {
    const store: SliceStore = {
      2: {
        ...emptySlice(2),
        vault: vault(1),
        sources: sources(1),
        milestones: { 1: ms(1, 1), 2: ms(2, 2), 3: ms(2, 1) /* wrong milestone for the slot */ },
      },
    };
    const s = sliceFor(store, 2)!;
    expect(s.vault).toBeUndefined();
    expect(s.sources).toBeUndefined();
    expect(s.milestones[1]).toBeUndefined();
    expect(s.milestones[2]?.vaultId).toBe(2);
    expect(s.milestones[3]).toBeUndefined();
  });
});

describe("putSlice", () => {
  it("writes only the slice's own key", () => {
    const a = { ...emptySlice(1), syncedAt: 5 };
    const b = { ...emptySlice(2), syncedAt: 6 };
    const s1 = putSlice({}, a);
    const s2 = putSlice(s1, b);
    expect(Object.keys(s2).sort()).toEqual(["1", "2"]);
    expect(s2[1]).toBe(a);
  });

  it("does not let an older read replace a newer one", () => {
    const newer = { ...emptySlice(1), syncedAt: 10, vault: vault(1) };
    const older = { ...emptySlice(1), syncedAt: 4 };
    const store = putSlice({ 1: newer }, older);
    expect(store[1]).toBe(newer);
  });

  it("lets a failed read (no ticket) through so the error is visible", () => {
    const good = { ...emptySlice(1), syncedAt: 10 };
    const failed = { ...emptySlice(1), syncedAt: null, error: "rpc" };
    expect(putSlice({ 1: good }, failed)[1]).toBe(failed);
  });

  it("returns a new store and leaves the old one untouched", () => {
    const base: SliceStore = { 1: emptySlice(1) };
    const next = putSlice(base, emptySlice(2));
    expect(next).not.toBe(base);
    expect(Object.keys(base)).toEqual(["1"]);
  });
});
