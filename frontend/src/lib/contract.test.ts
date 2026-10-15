import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let receipt: Record<string, unknown> = {};
let readResult: unknown = null;
const createClient = vi.fn();

vi.mock("genlayer-js", () => ({
  chains: { studioDevnet: { id: 61997, name: "studio", rpcUrls: { default: { http: ["https://old/"] } }, isStudio: true } },
  createClient: (cfg: Record<string, unknown>) => {
    createClient(cfg);
    return {
      readContract: async (a: { functionName: string }) => {
        calls.push(`read:${a.functionName}`);
        return readResult;
      },
      estimateTransactionFeesForWrite: async (a: { functionName: string; value?: bigint }) => {
        calls.push(`estimate:${a.functionName}:${a.value ?? 0n}`);
        return { feeValue: 1n };
      },
      writeContract: async (a: { functionName: string; fees?: unknown; value?: bigint }) => {
        calls.push(`write:${a.functionName}:${JSON.stringify(a.fees, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
        return "0xhash";
      },
      waitForTransactionReceipt: async () => {
        calls.push("wait");
        return receipt;
      },
    };
  },
}));

import { ShipOrSlashClient, ContractUnavailableError, type Eip1193Provider } from "./contract";
import { STUDIO_NEXT } from "./networks";

const ACCT_A = "0x2bd806c97F0e00aF1a1fC3328fA763a9269723C8";
const ACCT_B = "0x81b637d8fCD2C6da6359E6963113a1170de795e4";

function provider(accounts: string[]) {
  const listeners = new Map<string, (...a: unknown[]) => void>();
  const p: Eip1193Provider = {
    request: async () => accounts,
    on: (e, h) => void listeners.set(e, h),
    removeListener: (e) => void listeners.delete(e),
  };
  return { p, emit: (e: string, ...a: unknown[]) => listeners.get(e)?.(...a), has: (e: string) => listeners.has(e) };
}

const ok = { statusName: "ACCEPTED", txExecutionResultName: "FINISHED_WITH_RETURN", resultName: "MAJORITY_AGREE" };

beforeEach(() => {
  calls.length = 0;
  createClient.mockClear();
  receipt = { ...ok };
  readResult = null;
});

describe("ShipOrSlashClient", () => {
  it("reads with an account-less client pinned to the configured RPC", async () => {
    readResult = new Map<string, unknown>([
      ["vault_count", 1n],
      ["next_vault_id", 2n],
      ["total_escrow", "5"],
      ["total_released", "0"],
      ["total_slashed", "0"],
      ["contract_balance", "5"],
      ["solvent", true],
    ]);
    const c = new ShipOrSlashClient();
    const s = await c.protocolState();
    expect(s.vaultCount).toBe(1);
    const cfg = createClient.mock.calls[0]![0] as Record<string, unknown>;
    expect(cfg.account).toBeUndefined();
    const chain = cfg.chain as { id: number; isStudio: boolean; rpcUrls: { default: { http: string[] } } };
    expect(chain.id).toBe(61997);
    expect(chain.isStudio).toBe(true); // the SDK's own consensus fields survive
    expect(chain.rpcUrls.default.http).toEqual([STUDIO_NEXT.rpcUrl]); // only the RPC is overridden
  });

  it("refuses to write before a wallet is connected", async () => {
    const c = new ShipOrSlashClient();
    await expect(c.claimMilestone(1, 1)).rejects.toBeInstanceOf(ContractUnavailableError);
    expect(calls).toEqual([]);
  });

  it("estimates fees, writes with them, waits, then checks the receipt", async () => {
    const c = new ShipOrSlashClient();
    await c.connect(provider([ACCT_A]).p);
    const out = await c.claimMilestone(3, 2);
    expect(out.hash).toBe("0xhash");
    expect(calls).toEqual(["estimate:claim_milestone:0", 'write:claim_milestone:{"feeValue":"1"}', "wait"]);
  });

  it("forwards the deposit as the transaction value", async () => {
    const c = new ShipOrSlashClient();
    await c.connect(provider([ACCT_A]).p);
    await c.createVault({
      beneficiary: ACCT_B,
      repoUrl: "https://github.com/a/b",
      signerHash: "d".repeat(64),
      tagPrefix: "v",
      npmPackage: "p",
      dockerImage: "",
      feedA: "https://a.example.org/",
      feedB: "https://b.example.net/",
      feedC: "https://c.example.io/",
      deadline: 1_800_000_000,
      deposit: 5n * 10n ** 17n,
    });
    expect(calls[0]).toBe(`estimate:create_vault:${5n * 10n ** 17n}`);
  });

  it.each([
    [{ statusName: "PENDING" }, /not decided/],
    [{ txExecutionResultName: "FINISHED_WITH_ERROR" }, /did not return normally/],
    [{ resultName: "NO_MAJORITY" }, /majority/],
  ])("does not report success for a bad receipt %#", async (patch, msg) => {
    receipt = { ...ok, ...patch };
    const c = new ShipOrSlashClient();
    await c.connect(provider([ACCT_A]).p);
    await expect(c.withdrawReleased(1)).rejects.toThrow(msg);
  });

  it("binds account-scoped state to the wallet and clears it on accountsChanged", async () => {
    const w = provider([ACCT_A]);
    const c = new ShipOrSlashClient();
    await c.connect(w.p);
    expect(c.connectedAccount).toBe(ACCT_A.toLowerCase());
    c.accounts.set("vault:1", 1, ACCT_A);
    w.emit("accountsChanged", [ACCT_B]);
    expect(c.connectedAccount).toBe(ACCT_B.toLowerCase());
    expect(c.accounts.get("vault:1")).toBeUndefined();
    // the signer was bound to the old wallet; writing now must demand a reconnect
    await expect(c.claimMilestone(1, 1)).rejects.toBeInstanceOf(ContractUnavailableError);
  });

  it("treats an empty accountsChanged as a disconnect", async () => {
    const w = provider([ACCT_A]);
    const c = new ShipOrSlashClient();
    await c.connect(w.p);
    w.emit("accountsChanged", []);
    expect(c.connectedAccount).toBeNull();
  });

  it("removes its wallet listener on disconnect", async () => {
    const w = provider([ACCT_A]);
    const c = new ShipOrSlashClient();
    await c.connect(w.p);
    expect(w.has("accountsChanged")).toBe(true);
    c.disconnect();
    expect(w.has("accountsChanged")).toBe(false);
    expect(c.connectedAccount).toBeNull();
  });

  it("fails clearly when the wallet returns no account", async () => {
    const c = new ShipOrSlashClient();
    await expect(c.connect(provider([]).p)).rejects.toBeInstanceOf(ContractUnavailableError);
  });
});
