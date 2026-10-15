/**
 * Autonomous Studio Next deployment for contracts/ship_or_slash.py.
 *
 * Run with the CLI, which executes every script in deploy/ against a client
 * already bound to the selected network and active account:
 *
 *   genlayer account use shiporslash-deployer
 *   SHIPORSLASH_FOUNDER=0x<beneficiary> SHIPORSLASH_FEED_PIN=<commit sha> \
 *     genlayer deploy
 *
 * What it does, in order, and stops loudly at the first thing that is wrong:
 *
 *   1. Deploys the contract (or reuses SHIPORSLASH_ADDRESS if set).
 *   2. Seeds a vault with 0.5 GEN, bound to the founder and to three
 *      commit-pinned verifier mirrors on three distinct hosts and operators.
 *   3. Sends a live claim_milestone(1) and requires the receipt to be decided,
 *      executed to a return, and agreed by a validator majority.
 *   4. Reads the result back from the chain (get_vault_state,
 *      get_milestone_status, get_verifier_sources) and records addresses, hashes
 *      and the exact readbacks in deployments/studio-next.json.
 *
 * Nothing here holds a key: signing is the CLI's. Types are structural because
 * the CLI resolves the SDK from its own installation.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const CONTRACT_PATH = "contracts/ship_or_slash.py";
const RECORD_PATH = "deployments/studio-next.json";
const DEFAULT_PIN = "d332a2ed3f52ebe83c99233960a37598a41f96a4";
const SEED_WEI = 500_000_000_000_000_000n; // 0.5 GEN
const DEADLINE_DAYS = 30;
// Synthetic demo key: sha256 of the fingerprint the mock fixtures commit.
const DEMO_SIGNER_HASH = "d8a87fdcd4224662af9b788cae845191b3bc64b8155eb124fdbe0d506e4fcf10";
const RETRIES = 200;
const INTERVAL_MS = 5000;

interface Receipt {
  hash?: string;
  statusName?: string;
  txExecutionResultName?: string;
  resultName?: string;
  data?: { contract_address?: string };
  txDataDecoded?: { contractAddress?: string };
  [k: string]: unknown;
}

interface Fees {
  feeValue: bigint;
  [k: string]: unknown;
}

interface Client {
  initializeConsensusSmartContract?(): Promise<void>;
  estimateTransactionFees(input: Record<string, never>): Promise<Fees>;
  estimateTransactionFeesForWrite(input: {
    address: string;
    functionName: string;
    args?: unknown[];
    value?: bigint;
  }): Promise<Fees>;
  deployContract(input: { code: Uint8Array; args: unknown[]; fees?: Fees }): Promise<string>;
  writeContract(input: {
    address: string;
    functionName: string;
    args?: unknown[];
    value?: bigint;
    fees?: Fees;
  }): Promise<string>;
  readContract(input: { address: string; functionName: string; args?: unknown[] }): Promise<unknown>;
  waitForTransactionReceipt(input: {
    hash: string;
    waitUntil: "decided" | "finalized";
    retries: number;
    interval: number;
    fullTransaction?: boolean;
  }): Promise<Receipt>;
}

/** Decided, executed to a return, and agreed by a majority -- all three. */
function assertFinal(label: string, hash: string, r: Receipt): void {
  const problems: string[] = [];
  if (r.statusName !== "ACCEPTED" && r.statusName !== "FINALIZED") {
    problems.push(`status ${String(r.statusName)}`);
  }
  if (r.txExecutionResultName !== "FINISHED_WITH_RETURN") {
    problems.push(`execution ${String(r.txExecutionResultName)}`);
  }
  if (r.resultName !== "MAJORITY_AGREE") {
    problems.push(`consensus ${String(r.resultName)}`);
  }
  if (problems.length > 0) {
    throw new Error(`${label} (${hash}) did not finalise cleanly: ${problems.join("; ")}`);
  }
}

function plain(v: unknown): unknown {
  if (typeof v === "bigint") return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
  if (v instanceof Map) return Object.fromEntries(Array.from(v.entries(), ([k, x]) => [String(k), plain(x)]));
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, plain(x)]));
  }
  return v;
}

function addressFrom(r: Receipt): string | undefined {
  return (
    r.txDataDecoded?.contractAddress ??
    r.data?.contract_address ??
    (r.contractAddress as string | undefined) ??
    (r.contract_address as string | undefined)
  );
}

export default async function main(client: Client): Promise<string> {
  const pin = process.env.SHIPORSLASH_FEED_PIN ?? DEFAULT_PIN;
  if (!/^[0-9a-f]{40}$/.test(pin)) throw new Error("SHIPORSLASH_FEED_PIN must be a 40-hex commit sha");
  const founder = process.env.SHIPORSLASH_FOUNDER;
  if (!founder || !/^0x[0-9a-fA-F]{40}$/.test(founder)) {
    throw new Error("Set SHIPORSLASH_FOUNDER to the beneficiary's 0x address");
  }
  const feeds = {
    a: `https://raw.githubusercontent.com/SOBEK96/ShipOrSlash/${pin}/deployments/mock_feeds/a/`,
    b: `https://cdn.jsdelivr.net/gh/SOBEK96/ShipOrSlash@${pin}/deployments/mock_feeds/b/`,
    c: `https://raw.githack.com/SOBEK96/ShipOrSlash/${pin}/deployments/mock_feeds/c/`,
  };

  // Registers the consensus contract address and ABI on the client.
  await client.initializeConsensusSmartContract?.();

  const codePath = path.resolve(process.cwd(), CONTRACT_PATH);
  const code = readFileSync(codePath);
  const sourceSha256 = createHash("sha256").update(code).digest("hex");
  const record: Record<string, unknown> = {
    network: "studio-next",
    chain_id: 61997,
    rpc_url: "https://studio-next.genlayer.com/api",
    explorer_base: "https://explorer-studio-next.genlayer.com",
    source: CONTRACT_PATH,
    source_sha256: sourceSha256,
    runner: "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng",
    recorded_at: new Date().toISOString(),
  };

  // 1. Deploy (or reuse).
  let address = process.env.SHIPORSLASH_ADDRESS;
  if (address) {
    console.log(`Reusing contract ${address}`);
    record.deploy_tx = process.env.SHIPORSLASH_DEPLOY_TX ?? null;
  } else {
    // Studio Next has no fee manager: a deploy with no fee object resolves to a
    // zero deposit and the chain rejects it (FeeValueMustBeNonZero).
    const fees = await client.estimateTransactionFees({});
    const hash = await client.deployContract({ code: new Uint8Array(code), args: [], fees });
    const receipt = await client.waitForTransactionReceipt({
      hash,
      waitUntil: "decided",
      retries: RETRIES,
      interval: INTERVAL_MS,
      fullTransaction: true,
    });
    assertFinal("Deployment", hash, receipt);
    address = addressFrom(receipt);
    if (!address) throw new Error(`Deployment receipt carried no contract address: ${JSON.stringify(plain(receipt))}`);
    record.deploy_tx = hash;
    console.log(`Deployed ShipOrSlash at ${address} (${hash})`);
  }
  record.contract_address = address;
  record.explorer_url = `https://explorer-studio-next.genlayer.com/address/${address}`;

  // 2. Seed a vault with liquidity.
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_DAYS * 86_400);
  const createArgs = [
    founder,
    "https://github.com/SOBEK96/ShipOrSlash",
    DEMO_SIGNER_HASH,
    "v",
    "@sobek96/shiporslash",
    "sobek96/shiporslash",
    feeds.a,
    feeds.b,
    feeds.c,
    deadline,
  ];
  const createFees = await client.estimateTransactionFeesForWrite({
    address,
    functionName: "create_vault",
    args: createArgs,
    value: SEED_WEI,
  });
  const createHash_ = await client.writeContract({
    address,
    functionName: "create_vault",
    args: createArgs,
    value: SEED_WEI,
    fees: createFees,
  });
  const createReceipt = await client.waitForTransactionReceipt({
    hash: createHash_,
    waitUntil: "decided",
    retries: RETRIES,
    interval: INTERVAL_MS,
  });
  assertFinal("create_vault", createHash_, createReceipt);
  console.log(`Seeded vault with 0.5 GEN (${createHash_})`);
  record.seed_tx = createHash_;

  const proto = plain(await client.readContract({ address, functionName: "get_protocol_state" })) as Record<string, unknown>;
  const vaultId = Number(proto.vault_count);
  if (!Number.isInteger(vaultId) || vaultId < 1) throw new Error("vault_count did not advance after create_vault");
  record.vault_id = vaultId;

  // 3. Live milestone claim.
  const claimFees = await client.estimateTransactionFeesForWrite({
    address,
    functionName: "claim_milestone",
    args: [BigInt(vaultId), 1n],
  });
  const claimHash = await client.writeContract({
    address,
    functionName: "claim_milestone",
    args: [BigInt(vaultId), 1n],
    fees: claimFees,
  });
  const claimReceipt = await client.waitForTransactionReceipt({
    hash: claimHash,
    waitUntil: "decided",
    retries: RETRIES,
    interval: INTERVAL_MS,
  });
  assertFinal("claim_milestone", claimHash, claimReceipt);
  console.log(`claim_milestone(${vaultId}, 1) decided (${claimHash})`);
  record.claim_tx = claimHash;
  record.claim_status = claimReceipt.statusName;

  // 4. Authoritative readbacks.
  const read = async (functionName: string, args: unknown[] = []) =>
    plain(await client.readContract({ address: address as string, functionName, args }));
  const readbacks = {
    get_protocol_state: await read("get_protocol_state"),
    get_vault_state: await read("get_vault_state", [BigInt(vaultId)]),
    get_milestone_status: {
      "1": await read("get_milestone_status", [BigInt(vaultId), 1n]),
      "2": await read("get_milestone_status", [BigInt(vaultId), 2n]),
      "3": await read("get_milestone_status", [BigInt(vaultId), 3n]),
    },
    get_verifier_sources: await read("get_verifier_sources", [BigInt(vaultId)]),
  };
  record.readbacks = readbacks;
  record.feeds = feeds;
  record.feed_pin = pin;

  const out = path.resolve(process.cwd(), RECORD_PATH);
  if (!existsSync(path.dirname(out))) mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
  console.log(`Wrote ${RECORD_PATH}`);
  console.log(JSON.stringify(readbacks.get_milestone_status["1"], null, 2));
  return address;
}
