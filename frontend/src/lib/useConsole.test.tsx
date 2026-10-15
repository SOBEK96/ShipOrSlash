import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MilestoneStatus, VaultState, VerifierSources } from "./parse";
import { SerialLoader } from "./serialLoader";

// ---- a controllable fake of the contract client -----------------------------
type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mkVault = (id: number, deposited = 10n ** 18n): VaultState =>
  ({
    vaultId: id,
    status: "ACTIVE",
    funder: "0x2bd806c97f0e00af1a1fc3328fa763a9269723c8",
    beneficiary: "0x81b637d8fcd2c6da6359e6963113a1170de795e4",
    deposited,
    released: 0n,
    withdrawable: 0n,
    unreleased: deposited,
    tranchesDone: 0,
    tranches: [],
  }) as unknown as VaultState;
const mkSources = (id: number) => ({ vaultId: id, sources: [], independent: true }) as unknown as VerifierSources;
const mkMs = (id: number, m: 1 | 2 | 3) => ({ vaultId: id, milestoneId: m, claimableNow: m === 1 }) as unknown as MilestoneStatus;

const script = {
  /** Called for every (vault, item) read; tests replace it to stall or fail reads. */
  read: (_id: number, _key: string): Promise<unknown> => Promise.resolve(null),
  reads: [] as string[],
  claim: (_id: number): Promise<{ hash: string }> => Promise.resolve({ hash: "0xhash" }),
  create: (): Promise<{ hash: string; vaultId: number | null; vaultIdProblem?: string; deadline: number }> =>
    Promise.resolve({ hash: "0xc", vaultId: 1, deadline: 0 }),
};

vi.mock("./contract", async () => {
  const { SerialLoader: Loader } = await import("./serialLoader");
  class FakeClient {
    accounts = {
      current: "0x2bd806c97f0e00af1a1fc3328fa763a9269723c8" as string | null,
      subscribe: () => () => undefined,
    };
    protocolState = async () => ({
      vaultCount: 2,
      nextVaultId: 3,
      totalEscrow: 0n,
      totalReleased: 0n,
      totalSlashed: 0n,
      contractBalance: 0n,
      solvent: true,
    });
    vaultLoader(id: number) {
      return new Loader<string, unknown>(async (key) => {
        script.reads.push(`${id}:${key}`);
        return script.read(id, key);
      });
    }
    claimMilestone = (id: number) => script.claim(id);
    withdrawReleased = async () => ({ hash: "0x" });
    reclaimUnreleased = async () => ({ hash: "0x" });
    topUpVault = async () => ({ hash: "0x" });
    createVault = async () => script.create();
    connect = async () => "0x";
    disconnect = () => undefined;
  }
  return { ShipOrSlashClient: FakeClient, injectedProvider: () => null };
});

import { useConsole } from "./useConsole";

const okRead = (id: number, key: string): Promise<unknown> =>
  Promise.resolve(key === "vault" ? mkVault(id) : key === "sources" ? mkSources(id) : mkMs(id, Number(key.slice(1)) as 1 | 2 | 3));

async function flush(times = 6) {
  for (let i = 0; i < times; i++) await act(async () => Promise.resolve());
}

beforeEach(() => {
  vi.useFakeTimers();
  script.reads = [];
  script.read = okRead;
  script.claim = () => Promise.resolve({ hash: "0xhash" });
  script.create = () => Promise.resolve({ hash: "0xc", vaultId: 1, deadline: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useConsole: vault isolation", () => {
  it("renders only the selected vault's data", async () => {
    const { result } = renderHook(() => useConsole());
    act(() => result.current.selectVault(1));
    await flush();
    expect(result.current.data.vault?.vaultId).toBe(1);
    act(() => result.current.selectVault(2));
    await flush();
    expect(result.current.data.vault?.vaultId).toBe(2);
    expect(result.current.vaultId).toBe(2);
  });

  it("never shows vault 1 under vault 2 while vault 2 is still loading", async () => {
    const { result } = renderHook(() => useConsole());
    act(() => result.current.selectVault(1));
    await flush();
    expect(result.current.data.vault?.vaultId).toBe(1);

    const stall = defer<unknown>();
    script.read = (id, key) => (id === 2 ? stall.promise : okRead(id, key));
    act(() => result.current.selectVault(2));
    await flush();
    // vault 2 has not answered: the panel must be empty, not vault 1's data.
    expect(result.current.data.vault).toBeUndefined();
    expect(result.current.data.sources).toBeUndefined();
    expect(Object.keys(result.current.data.milestones)).toHaveLength(0);
    stall.resolve(null);
  });

  it("a late response for vault 1 does not overwrite vault 2 after switching", async () => {
    const slow = defer<unknown>();
    script.read = (id, key) => (id === 1 && key === "vault" ? slow.promise : okRead(id, key));
    const { result } = renderHook(() => useConsole());
    act(() => result.current.selectVault(1));
    await flush();
    act(() => result.current.selectVault(2));
    await flush();
    expect(result.current.data.vault?.vaultId).toBe(2);

    await act(async () => {
      slow.resolve(mkVault(1, 7n * 10n ** 18n)); // vault 1's slow read lands now
      await Promise.resolve();
    });
    await flush();
    expect(result.current.vaultId).toBe(2);
    expect(result.current.data.vault?.vaultId).toBe(2);
    expect(result.current.data.vault?.deposited).toBe(10n ** 18n);
  });

  it("a transaction finishing for vault 1 after switching to vault 2 does not touch vault 2's view", async () => {
    const tx = defer<{ hash: string }>();
    script.claim = () => tx.promise;
    const { result } = renderHook(() => useConsole());
    act(() => result.current.selectVault(1));
    await flush();

    let claimed: Promise<void> | undefined;
    act(() => {
      claimed = result.current.claim(1) as Promise<void>;
    });
    await flush();
    act(() => result.current.selectVault(2)); // user moves on while the tx is pending
    await flush();
    expect(result.current.data.vault?.vaultId).toBe(2);

    await act(async () => {
      tx.resolve({ hash: "0xabc" });
      await claimed;
    });
    await flush();
    expect(result.current.vaultId).toBe(2);
    expect(result.current.data.vault?.vaultId).toBe(2);
    // the post-transaction refresh targeted vault 1's own slice
    expect(script.reads.filter((r) => r.startsWith("1:vault")).length).toBeGreaterThanOrEqual(2);
  });

  it("an RPC answer for the wrong vault is a failed item, not a value", async () => {
    script.read = (id, key) => (key === "vault" ? Promise.resolve(mkVault(id === 2 ? 1 : id)) : okRead(id, key));
    // The fake loader does not validate ids (the real client does); the slice
    // layer is the second line of defence and must still refuse the mismatch.
    const { result } = renderHook(() => useConsole());
    act(() => result.current.selectVault(2));
    await flush();
    expect(result.current.data.vault).toBeUndefined();
  });
});

describe("useConsole: creating a vault", () => {
  const input = { beneficiary: "0x", repoUrl: "", signerHash: "", tagPrefix: "v" as const, npmPackage: "", dockerImage: "",
    feedA: "", feedB: "", feedC: "", deadlineDays: 30, deposit: 1n };

  it("selects the id the transaction returned, not the newest vault", async () => {
    // protocolState() in the fake reports vaultCount 2: another creator's vault is the newest.
    script.create = () => Promise.resolve({ hash: "0xc", vaultId: 1, deadline: 0 });
    const { result } = renderHook(() => useConsole());
    await flush();
    await act(async () => {
      await result.current.createVault(input);
    });
    await flush();
    expect(result.current.vaultId).toBe(1);
  });

  it("does not guess when the id could not be read", async () => {
    script.create = () => Promise.resolve({ hash: "0xc", vaultId: null, vaultIdProblem: "no leader result", deadline: 0 });
    const { result } = renderHook(() => useConsole());
    act(() => result.current.selectVault(2));
    await flush();
    await act(async () => {
      await result.current.createVault(input);
    });
    await flush();
    expect(result.current.vaultId).toBe(2); // selection unchanged
    expect(result.current.notice?.kind).toBe("info");
    expect(result.current.notice?.message).toMatch(/could not be read from the receipt/);
  });

  it("surfaces a mismatch as an error and selects nothing", async () => {
    script.create = () => Promise.reject(new Error("The receipt names vault 4, which is not the vault this transaction created."));
    const { result } = renderHook(() => useConsole());
    await flush();
    await act(async () => {
      await result.current.createVault(input);
    });
    await flush();
    expect(result.current.vaultId).toBeNull();
    expect(result.current.notice?.kind).toBe("error");
  });
});

describe("useConsole: slow polling", () => {
  it("does not start overlapping reads while one is in flight", async () => {
    const stall = defer<unknown>();
    script.read = (id, key) => (key === "vault" ? stall.promise : okRead(id, key));
    const { result } = renderHook(() => useConsole());
    act(() => result.current.selectVault(1));
    await flush();
    const vaultReadsBefore = script.reads.filter((r) => r === "1:vault").length;
    expect(vaultReadsBefore).toBe(1);

    // five full poll intervals pass while the RPC is stalled
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
    }
    expect(script.reads.filter((r) => r === "1:vault").length).toBe(1);

    await act(async () => {
      stall.resolve(mkVault(1));
      await Promise.resolve();
    });
    await flush();
    expect(result.current.data.vault?.vaultId).toBe(1); // the slow read still landed
  });

  it("schedules the next poll only after the previous read settles", async () => {
    const { result } = renderHook(() => useConsole());
    act(() => result.current.selectVault(1));
    await flush();
    const first = script.reads.filter((r) => r === "1:vault").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    await flush();
    expect(script.reads.filter((r) => r === "1:vault").length).toBe(first + 1);
  });

  it("an explicit refresh during a slow read queues one follow-up, not a pile", async () => {
    const stall = defer<unknown>();
    let first = true;
    script.read = (id, key) => {
      if (key === "vault" && first) {
        first = false;
        return stall.promise;
      }
      return okRead(id, key);
    };
    const { result } = renderHook(() => useConsole());
    act(() => result.current.selectVault(1));
    await flush();
    act(() => {
      void result.current.refresh();
      void result.current.refresh();
      void result.current.refresh();
    });
    await flush();
    expect(script.reads.filter((r) => r === "1:vault").length).toBe(1);
    await act(async () => {
      stall.resolve(mkVault(1));
      await Promise.resolve();
    });
    await flush(12);
    expect(script.reads.filter((r) => r === "1:vault").length).toBe(2); // exactly one follow-up
  });
});

describe("sanity: SerialLoader is the real one", () => {
  it("is constructible", () => {
    expect(new SerialLoader<string, number>(async () => 1)).toBeDefined();
  });
});
