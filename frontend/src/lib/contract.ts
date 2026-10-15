/**
 * ShipOrSlash client: the single place the console talks to GenLayer.
 *
 *  - Reads use an account-less client (views are `gen_call`s and need no
 *    signer), so protocol state renders before any wallet connects and behaves
 *    identically after.
 *  - Writes use an EIP-1193 signer. Every write is fee-estimated with the SDK's
 *    `estimateTransactionFeesForWrite` -- Studio Next has no fee manager, and a
 *    write with no fee object resolves to a zero deposit that the chain rejects.
 *  - A write is not "done" when it is submitted. It is done when the receipt
 *    satisfies `assertFinalReceipt`: decided, executed to a return, and agreed
 *    by a validator majority.
 *  - Reads go through a SerialLoader so one failing item cannot blank the rest.
 */

import { AccountScopedState, canonicalAccount } from "./accountScope";
import {
  ParseError,
  parseMilestoneStatus,
  parseProtocolState,
  parseVaultState,
  parseVerifierSources,
  type MilestoneStatus,
  type ProtocolState,
  type VaultState,
  type VerifierSources,
} from "./parse";
import { assertFinalReceipt, type ReceiptLike } from "./receipt";
import { CONTRACT_ADDRESS, DEFAULT_NETWORK, type NetworkConfig } from "./networks";
import { SerialLoader } from "./serialLoader";
import type { MilestoneId } from "./protocol";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

interface SdkClient {
  readContract(args: { address: string; functionName: string; args?: unknown[] }): Promise<unknown>;
  writeContract(args: {
    address: string;
    functionName: string;
    args?: unknown[];
    value?: bigint;
    fees?: unknown;
  }): Promise<string>;
  estimateTransactionFeesForWrite(args: {
    address: string;
    functionName: string;
    args?: unknown[];
    value?: bigint;
    account?: string;
  }): Promise<unknown>;
  waitForTransactionReceipt(args: {
    hash: string;
    waitUntil?: "decided" | "finalized";
    retries?: number;
    interval?: number;
  }): Promise<ReceiptLike>;
}

interface SdkChain {
  rpcUrls?: { default?: { http?: string[] } };
  [k: string]: unknown;
}

interface SdkModule {
  createClient(cfg: Record<string, unknown>): SdkClient;
  chains: Record<string, SdkChain | undefined>;
}

export class ContractUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractUnavailableError";
  }
}

export interface CreateVaultInput {
  beneficiary: string;
  repoUrl: string;
  signerHash: string;
  tagPrefix: "" | "v";
  npmPackage: string;
  dockerImage: string;
  feedA: string;
  feedB: string;
  feedC: string;
  deadline: number;
  deposit: bigint;
}

export interface WriteOutcome {
  hash: string;
  receipt: ReceiptLike;
}

const RETRIES = 120;
const INTERVAL_MS = 3000;

export class ShipOrSlashClient {
  private reader: SdkClient | null = null;
  private signer: SdkClient | null = null;
  private provider: Eip1193Provider | null = null;
  private sdk: SdkModule | null = null;
  readonly accounts = new AccountScopedState<unknown>();
  private accountsListener: ((...a: unknown[]) => void) | null = null;

  constructor(
    readonly network: NetworkConfig = DEFAULT_NETWORK,
    readonly address: string = CONTRACT_ADDRESS,
  ) {}

  // ---------------------------------------------------------------- SDK ----
  private async loadSdk(): Promise<SdkModule> {
    if (this.sdk) return this.sdk;
    const mod = (await import("genlayer-js")) as unknown as SdkModule;
    if (typeof mod.createClient !== "function" || !mod.chains) {
      throw new ContractUnavailableError("genlayer-js did not load.");
    }
    this.sdk = mod;
    return mod;
  }

  /** The SDK's own chain object with only the RPC overridden. Hand-built chain
   * objects miss the consensus fields the SDK reads on every write. */
  private async chain(): Promise<SdkChain> {
    const sdk = await this.loadSdk();
    const base = sdk.chains[this.network.sdkChain];
    if (!base) throw new ContractUnavailableError(`genlayer-js ships no ${this.network.sdkChain} chain.`);
    return { ...base, rpcUrls: { default: { http: [this.network.rpcUrl] } } };
  }

  private async readClient(): Promise<SdkClient> {
    if (this.reader) return this.reader;
    const sdk = await this.loadSdk();
    this.reader = sdk.createClient({ chain: await this.chain() });
    return this.reader;
  }

  // ------------------------------------------------------------- wallet ----
  get connectedAccount(): string | null {
    return this.accounts.current;
  }

  /** Connect an injected EIP-1193 wallet and bind every per-account panel to it. */
  async connect(provider: Eip1193Provider): Promise<string> {
    const accts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    const account = canonicalAccount(accts?.[0]);
    if (!account) throw new ContractUnavailableError("The wallet returned no account.");
    const sdk = await this.loadSdk();
    this.provider = provider;
    this.signer = sdk.createClient({ chain: await this.chain(), account, provider });
    this.accounts.setAccount(account);
    this.watch(provider);
    return account;
  }

  private watch(provider: Eip1193Provider): void {
    this.unwatch();
    const handler = (...args: unknown[]) => {
      const list = Array.isArray(args[0]) ? (args[0] as string[]) : [];
      const changed = this.accounts.handleAccountsChanged(list);
      if (changed) {
        // The signer is bound to the old address: drop it. The caller reconnects.
        this.signer = null;
      }
    };
    provider.on?.("accountsChanged", handler);
    this.accountsListener = handler;
  }

  private unwatch(): void {
    if (this.provider && this.accountsListener) {
      this.provider.removeListener?.("accountsChanged", this.accountsListener);
    }
    this.accountsListener = null;
  }

  disconnect(): void {
    this.unwatch();
    this.signer = null;
    this.provider = null;
    this.accounts.setAccount(null);
  }

  // -------------------------------------------------------------- reads ----
  private async view(functionName: string, args: unknown[] = []): Promise<unknown> {
    const client = await this.readClient();
    return client.readContract({ address: this.address, functionName, args });
  }

  async protocolState(): Promise<ProtocolState> {
    return parseProtocolState(await this.view("get_protocol_state"));
  }

  async vaultState(vaultId: number): Promise<VaultState> {
    return parseVaultState(await this.view("get_vault_state", [BigInt(vaultId)]));
  }

  async milestoneStatus(vaultId: number, milestone: MilestoneId): Promise<MilestoneStatus> {
    return parseMilestoneStatus(
      await this.view("get_milestone_status", [BigInt(vaultId), BigInt(milestone)]),
    );
  }

  async verifierSources(vaultId: number): Promise<VerifierSources> {
    return parseVerifierSources(await this.view("get_verifier_sources", [BigInt(vaultId)]));
  }

  /** A SerialLoader over one vault's reads, keyed by item name. */
  vaultLoader(vaultId: number): SerialLoader<string, unknown> {
    return new SerialLoader<string, unknown>(async (key) => {
      switch (key) {
        case "vault":
          return this.vaultState(vaultId);
        case "sources":
          return this.verifierSources(vaultId);
        case "m1":
          return this.milestoneStatus(vaultId, 1);
        case "m2":
          return this.milestoneStatus(vaultId, 2);
        case "m3":
          return this.milestoneStatus(vaultId, 3);
        default:
          throw new ParseError(`unknown item ${key}`);
      }
    });
  }

  // ------------------------------------------------------------- writes ----
  private requireSigner(): SdkClient {
    if (!this.signer || !this.accounts.current) {
      throw new ContractUnavailableError("Connect a wallet before sending a transaction.");
    }
    return this.signer;
  }

  private async send(functionName: string, args: unknown[], value = 0n): Promise<WriteOutcome> {
    const signer = this.requireSigner();
    const account = this.accounts.current!;
    // The account the user approved with. If the wallet switches while we wait,
    // the receipt is still reported, but never written into the new account's
    // scope (callers pass `forAccount`).
    const fees = await signer.estimateTransactionFeesForWrite({
      address: this.address,
      functionName,
      args,
      value,
      account,
    });
    const hash = await signer.writeContract({
      address: this.address,
      functionName,
      args,
      value,
      fees,
    });
    const receipt = await signer.waitForTransactionReceipt({
      hash,
      waitUntil: "decided",
      retries: RETRIES,
      interval: INTERVAL_MS,
    });
    assertFinalReceipt(receipt);
    return { hash, receipt };
  }

  createVault(input: CreateVaultInput): Promise<WriteOutcome> {
    return this.send(
      "create_vault",
      [
        input.beneficiary,
        input.repoUrl,
        input.signerHash,
        input.tagPrefix,
        input.npmPackage,
        input.dockerImage,
        input.feedA,
        input.feedB,
        input.feedC,
        BigInt(input.deadline),
      ],
      input.deposit,
    );
  }

  topUpVault(vaultId: number, value: bigint): Promise<WriteOutcome> {
    return this.send("top_up_vault", [BigInt(vaultId)], value);
  }

  claimMilestone(vaultId: number, milestone: MilestoneId): Promise<WriteOutcome> {
    return this.send("claim_milestone", [BigInt(vaultId), BigInt(milestone)]);
  }

  withdrawReleased(vaultId: number): Promise<WriteOutcome> {
    return this.send("withdraw_released", [BigInt(vaultId)]);
  }

  reclaimUnreleased(vaultId: number): Promise<WriteOutcome> {
    return this.send("reclaim_unreleased", [BigInt(vaultId)]);
  }
}

export function injectedProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  return eth ?? null;
}
