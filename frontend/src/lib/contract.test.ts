import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const written: { functionName: string; args?: unknown[]; value?: bigint }[] = [];
let receipt: Record<string, unknown> = {};
let readResult: unknown = null;
/** Per-function read answers; falls back to `readResult`. */
let readFor: Record<string, unknown> = {};
const createClient = vi.fn();

vi.mock("genlayer-js", async () => ({
  abi: ((await vi.importActual("genlayer-js")) as { abi: unknown }).abi,
  chains: { studioDevnet: { id: 61997, name: "studio", rpcUrls: { default: { http: ["https://old/"] } }, isStudio: true } },
  createClient: (cfg: Record<string, unknown>) => {
    createClient(cfg);
    return {
      readContract: async (a: { functionName: string }) => {
        calls.push(`read:${a.functionName}`);
        return a.functionName in readFor ? readFor[a.functionName] : readResult;
      },
      estimateTransactionFeesForWrite: async (a: { functionName: string; value?: bigint }) => {
        calls.push(`estimate:${a.functionName}:${a.value ?? 0n}`);
        return { feeValue: 1n };
      },
      writeContract: async (a: { functionName: string; args?: unknown[]; fees?: unknown; value?: bigint }) => {
        written.push({ functionName: a.functionName, args: a.args, value: a.value });
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
  written.length = 0;
  createClient.mockClear();
  receipt = { ...ok };
  readResult = null;
  readFor = {};
});

describe("ShipOrSlashClient", () => {
  it("reads with an account-less client pinned to the configured RPC", async () => {
    readResult = new Map<string, unknown>([
      ["vault_count", 1n],
      ["next_vault_id", 2n],
      ["total_escrow", "5"],
      ["total_released", "0"],
      ["total_slashed", "0"],
      ["total_cancelled", "0"],
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
      deadlineDays: 30,
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

// ---- create_vault: the id comes from the receipt, never from the count ----
const FOUNDER = "0xE24e3cD8f1b7dc8fBC5718F16334b89f88bdA670";
const REPO = "https://github.com/SOBEK96/ShipOrSlash";
const input = {
  beneficiary: FOUNDER,
  repoUrl: REPO,
  signerHash: "d".repeat(64),
  tagPrefix: "v" as const,
  npmPackage: "p",
  dockerImage: "",
  feedA: "https://a.example.org/",
  feedB: "https://b.example.net/",
  feedC: "https://c.example.io/",
  deadlineDays: 30,
  deposit: 5n * 10n ** 17n,
};

/** A get_vault_state answer, as the SDK would decode it. */
const vaultView = (id: number, over: Record<string, unknown> = {}) => ({
  vault_id: id, status: "ACTIVE", funder: ACCT_A.toLowerCase(), beneficiary: FOUNDER.toLowerCase(),
  repo_url: "https://github.com/sobek96/shiporslash", signer_hash: "d".repeat(64), tag_prefix: "v", accept_deadline: 1_700_172_800, accepted_at: 0,
  npm_package: "p", docker_image: "", feeds: ["a", "b", "c"], deadline: 2_000_000_000, created_at: 1_700_000_000,
  deposited: "500000000000000000", released: "0", withdrawn: "0", reclaimed: "0", withdrawable: "0",
  unreleased: "500000000000000000", tranches_done: 0, attempts: 0, last_verdict: 0, last_source_count: 0,
  last_attempt_at: 0, last_milestone: 0,
  tranches: [1, 2, 3].map((m) => ({
    milestone_id: m, kind: ["ALPHA", "RC", "STABLE"][m - 1], bps: [2000, 3000, 5000][m - 1], status: m === 1 ? "PENDING" : "LOCKED",
    release_tag: "", commit_sha: "", artifact_digest: "", verified_ts: 0, amount: "1",
  })),
  ...over,
});

const receiptReturning = (readable: string) => ({
  ...ok,
  consensus_data: { leader_receipt: [{ mode: "leader", execution_result: "SUCCESS", result: { status: "return", payload: { readable } } }] },
});

describe("ShipOrSlashClient.createVault", () => {
  it("returns the id the transaction returned, even when another creator moved the count", async () => {
    receipt = receiptReturning("3");
    readFor = {
      // someone else created vaults 4..7 in the meantime: the global count is 7
      get_protocol_state: new Map<string, unknown>([["vault_count", 7n]]),
      get_vault_state: vaultView(3),
    };
    const c = new ShipOrSlashClient();
    await c.connect(provider([ACCT_A]).p);
    const out = await c.createVault(input);
    expect(out.vaultId).toBe(3); // not 7
    expect(calls).not.toContain("read:get_protocol_state"); // the count is never consulted
  });

  it("reads the id from the real captured receipt shape", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    receipt = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "create_vault_receipt.full.json"), "utf8"));
    readFor = { get_vault_state: vaultView(1) };
    const c = new ShipOrSlashClient();
    await c.connect(provider([ACCT_A]).p);
    expect((await c.createVault(input)).vaultId).toBe(1);
  });

  it.each([
    ["a different creator", { funder: ACCT_B.toLowerCase() }],
    ["a different repository", { repo_url: "https://github.com/someone/else" }],
    ["a smaller deposit", { deposited: "1" }],
    ["a different beneficiary", { beneficiary: ACCT_B.toLowerCase() }],
  ])("refuses a receipt id that names a vault with %s", async (_n, over) => {
    receipt = receiptReturning("2");
    readFor = { get_vault_state: vaultView(2, over) };
    const c = new ShipOrSlashClient();
    await c.connect(provider([ACCT_A]).p);
    await expect(c.createVault(input)).rejects.toThrow(/not the vault this transaction created/);
  });

  it("reports an unreadable receipt as an unknown id, and does not guess", async () => {
    receipt = { ...ok }; // no consensus_data at all
    readFor = { get_protocol_state: new Map<string, unknown>([["vault_count", 9n]]) };
    const c = new ShipOrSlashClient();
    await c.connect(provider([ACCT_A]).p);
    const out = await c.createVault(input);
    expect(out.vaultId).toBeNull();
    expect(out.vaultIdProblem).toMatch(/leader result/);
  });

  it("sends a deadline from the chain's clock, with the skew buffer", async () => {
    const realFetch = globalThis.fetch;
    const chainNow = Math.floor(Date.now() / 1000) + 600; // chain 10 minutes ahead of this client
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ result: { timestamp: `0x${chainNow.toString(16)}` } }),
    })) as unknown as typeof fetch;
    try {
      receipt = receiptReturning("1");
      readFor = { get_vault_state: vaultView(1) };
      const c = new ShipOrSlashClient();
      await c.connect(provider([ACCT_A]).p);
      const out = await c.createVault({ ...input, deadlineDays: 3 });
      expect(out.deadline).toBe(chainNow + 3 * 86_400 + 3_600);
      const w = written.find((x) => x.functionName === "create_vault")!;
      expect(w.args![9]).toBe(BigInt(chainNow + 3 * 86_400 + 3_600));
      expect(w.value).toBe(5n * 10n ** 17n);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("falls back to the client clock when the chain's cannot be read", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    try {
      receipt = receiptReturning("1");
      readFor = { get_vault_state: vaultView(1) };
      const c = new ShipOrSlashClient();
      await c.connect(provider([ACCT_A]).p);
      const before = Math.floor(Date.now() / 1000);
      const out = await c.createVault({ ...input, deadlineDays: 3 });
      expect(out.deadline).toBeGreaterThanOrEqual(before + 3 * 86_400 + 3_600);
      expect(out.deadline).toBeLessThanOrEqual(before + 3 * 86_400 + 3_600 + 5);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("offer lifecycle writes", () => {
  it.each([
    ["accept_vault_terms", (c: ShipOrSlashClient) => c.acceptVaultTerms(4)],
    ["reject_vault_terms", (c: ShipOrSlashClient) => c.rejectVaultTerms(4)],
    ["cancel_vault", (c: ShipOrSlashClient) => c.cancelVault(4)],
  ])("%s estimates fees, writes with them, waits and checks the receipt", async (fn, call) => {
    const c = new ShipOrSlashClient();
    await c.connect(provider([ACCT_A]).p);
    const out = await call(c);
    expect(out.hash).toBe("0xhash");
    expect(calls).toEqual([`estimate:${fn}:0`, `write:${fn}:{"feeValue":"1"}`, "wait"]);
    expect(written[0]).toMatchObject({ functionName: fn, args: [4n] });
  });

  it.each([
    ["acceptVaultTerms"],
    ["rejectVaultTerms"],
    ["cancelVault"],
  ] as const)("%s refuses to send without a wallet", async (method) => {
    const c = new ShipOrSlashClient();
    await expect(c[method](1)).rejects.toBeInstanceOf(ContractUnavailableError);
    expect(calls).toEqual([]);
  });

  it.each([
    [{ statusName: "PENDING" }, /not decided/],
    [{ txExecutionResultName: "FINISHED_WITH_ERROR" }, /did not return normally/],
    [{ resultName: "NO_MAJORITY" }, /majority/],
  ])("does not report an accept as done on a bad receipt %#", async (patch, msg) => {
    receipt = { ...ok, ...patch };
    const c = new ShipOrSlashClient();
    await c.connect(provider([ACCT_B]).p);
    await expect(c.acceptVaultTerms(1)).rejects.toThrow(msg);
  });
});
