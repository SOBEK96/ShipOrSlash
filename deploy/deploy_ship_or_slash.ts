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
 * A new vault is only an OFFER: the funder chooses the verifier mirrors, so the
 * beneficiary must inspect them and call accept_vault_terms from their own
 * wallet before anything can be claimed. The script therefore runs in two
 * passes, and is safe to re-run:
 *
 *   pass 1 (as the funder)   deploy (or reuse SHIPORSLASH_ADDRESS), create the
 *                            vault with 0.5 GEN, read the new id from the
 *                            transaction's own receipt, report
 *                            PENDING_ACCEPTANCE and stop.
 *   (as the beneficiary)     genlayer account use shiporslash-founder
 *                            genlayer write <addr> accept_vault_terms --args <id> --fees ...
 *   pass 2 (as the funder)   SHIPORSLASH_ADDRESS=<addr> SHIPORSLASH_VAULT_ID=<id> genlayer deploy
 *                            sees the vault ACTIVE, sends a live
 *                            claim_milestone(1) and requires the receipt to be
 *                            decided, executed to a return, and agreed by a
 *                            validator majority.
 *
 * Both passes read the result back from the chain (get_vault_state,
 * get_milestone_status, get_verifier_sources) and record addresses, hashes and
 * the exact readbacks in deployments/studio-next.json. It stops loudly at the
 * first thing that is wrong.
 *
 * Nothing here holds a key: signing is the CLI's. Types are structural because
 * the CLI resolves the SDK from its own installation.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const CONTRACT_PATH = "contracts/ship_or_slash.py";
const RECORD_PATH = process.env.SHIPORSLASH_RECORD_PATH ?? "deployments/studio-next.json";
const DEFAULT_PIN = "2d32a3d0968cb48960374dcceb7a0f75434e4d59";
const SEED_WEI = process.env.SHIPORSLASH_SEED_WEI ? BigInt(process.env.SHIPORSLASH_SEED_WEI) : 500_000_000_000_000_000n; // default 0.5 GEN
const DEADLINE_DAYS = 30;
// Synthetic demo key: sha256 of the fingerprint the mock fixtures commit.
const DEMO_SIGNER_HASH = "d8a87fdcd4224662af9b788cae845191b3bc64b8155eb124fdbe0d506e4fcf10";
const RETRIES = 200;
const INTERVAL_MS = 5000;

interface Receipt {
  hash?: string;
  // Studio Next populates these differently from the SDK's declared shape: the
  // status is a string, and the consensus result is `result_name` / `result`
  // with `resultName` absent. See assertFinal.
  statusName?: string;
  status?: string | number;
  txExecutionResultName?: string;
  txExecutionResult?: string | number;
  resultName?: string;
  result_name?: string;
  result?: string | number;
  data?: { contract_address?: string };
  txDataDecoded?: { contractAddress?: string };
  consensus_data?: unknown;
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

// Mirror frontend/src/lib/receipt.ts (a test keeps the two maps identical).
const STATUS_BY_NUMBER: Record<string, string> = {"0":"UNINITIALIZED","1":"PENDING","2":"PROPOSING","3":"COMMITTING","4":"REVEALING","5":"ACCEPTED","6":"UNDETERMINED","7":"FINALIZED","8":"CANCELED","9":"APPEAL_REVEALING","10":"APPEAL_COMMITTING","11":"VALIDATORS_TIMEOUT","12":"LEADER_TIMEOUT","13":"LEADER_REVEALING"};
const EXEC_BY_NUMBER: Record<string, string> = {"0":"NOT_VOTED","1":"FINISHED_WITH_RETURN","2":"FINISHED_WITH_ERROR","3":"TIMEOUT","4":"NONDET_DISAGREE","5":"DETERMINISTIC_VIOLATION"};
const RESULT_BY_NUMBER: Record<string, string> = {"0":"IDLE","1":"MAJORITY_AGREE","2":"MAJORITY_DISAGREE","3":"MAJORITY_TIMEOUT","4":"DETERMINISTIC_VIOLATION","5":"NO_MAJORITY"};

/** One fact from its candidate name fields and its number; a conflict is an error. */
function fact(label: string, names: unknown[], numeric: unknown, byNumber: Record<string, string>): string {
  const found = new Set<string>();
  for (const n of names) {
    if (typeof n === "string" && n !== "") found.add(/^[0-9]+$/.test(n) ? (byNumber[n] ?? n) : n);
  }
  if (typeof numeric === "number" || (typeof numeric === "string" && /^[0-9]+$/.test(numeric))) {
    const m = byNumber[String(numeric)];
    if (m !== undefined) found.add(m);
  }
  if (found.size > 1) throw new Error(`${label} fields contradict each other: ${Array.from(found).join(" vs ")}`);
  const v = found.values().next().value as string | undefined;
  if (v === undefined) throw new Error(`${label} is missing from the receipt`);
  return v;
}

/** Decided, executed to a return, and agreed by a majority -- all three. */
function assertFinal(label: string, hash: string, r: Receipt): void {
  const problems: string[] = [];
  try {
    const status = fact("status", [r.statusName, r.status], r.status, STATUS_BY_NUMBER);
    if (status !== "ACCEPTED" && status !== "FINALIZED") problems.push(`status ${status}`);
    const exec = fact("execution result", [r.txExecutionResultName], r.txExecutionResult, EXEC_BY_NUMBER);
    if (exec !== "FINISHED_WITH_RETURN") problems.push(`execution ${exec}`);
    const result = fact("consensus result", [r.resultName, r.result_name], r.result, RESULT_BY_NUMBER);
    if (result !== "MAJORITY_AGREE") problems.push(`consensus ${result}`);
  } catch (e) {
    problems.push((e as Error).message);
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

/** The id create_vault returned, from the leader's entry in the receipt. */
function idFromReceipt(r: Receipt): number {
  const cd = (r.consensus_data ?? (r as Record<string, unknown>).consensusData) as { leader_receipt?: unknown } | undefined;
  const list = Array.isArray(cd?.leader_receipt) ? (cd!.leader_receipt as Record<string, any>[]) : [];
  const leaders = list.filter((e) => e && e.mode === "leader");
  if (leaders.length !== 1) throw new Error("receipt has no unique leader entry; cannot read the vault id");
  const readable = leaders[0]!.result?.payload?.readable;
  if (typeof readable !== "string" || !/^[1-9][0-9]*$/.test(readable)) {
    throw new Error(`create_vault did not return a positive integer id (got ${JSON.stringify(readable)})`);
  }
  return Number(readable);
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
  // Which fixture directory the mirrors serve (mock_feeds, or mock_feeds_lag for
  // the lag demonstration where only mirror A carries the record).
  const feedDir = process.env.SHIPORSLASH_FEED_DIR ?? "mock_feeds";
  if (!/^[a-z_]+$/.test(feedDir)) throw new Error("SHIPORSLASH_FEED_DIR must be a plain directory name");
  const feeds = {
    a: `https://raw.githubusercontent.com/SOBEK96/ShipOrSlash/${pin}/deployments/${feedDir}/a/`,
    b: `https://cdn.jsdelivr.net/gh/SOBEK96/ShipOrSlash@${pin}/deployments/${feedDir}/b/`,
    c: `https://raw.githack.com/SOBEK96/ShipOrSlash/${pin}/deployments/${feedDir}/c/`,
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

  // 2. Create the offer (unless re-running against an existing vault).
  let vaultId: number | null = process.env.SHIPORSLASH_VAULT_ID ? Number(process.env.SHIPORSLASH_VAULT_ID) : null;
  if (vaultId !== null && (!Number.isInteger(vaultId) || vaultId < 1)) throw new Error("SHIPORSLASH_VAULT_ID must be a positive integer");
  if (vaultId === null) {
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
    // The id is what create_vault RETURNED, read from this transaction's own
    // receipt -- never inferred from the global vault count.
    vaultId = idFromReceipt(createReceipt);
    console.log(`Created vault ${vaultId} with ${SEED_WEI} wei as an offer (${createHash_})`);
    record.seed_tx = createHash_;
  } else {
    record.seed_tx = process.env.SHIPORSLASH_SEED_TX ?? null;
  }
  record.vault_id = vaultId;
  record.accept_tx = process.env.SHIPORSLASH_ACCEPT_TX ?? null;

  const read = async (functionName: string, args: unknown[] = []) =>
    plain(await client.readContract({ address: address as string, functionName, args }));
  const vault = (await read("get_vault_state", [BigInt(vaultId)])) as Record<string, unknown>;
  if (String(vault.funder).toLowerCase() === String(vault.beneficiary).toLowerCase()) throw new Error("funder and beneficiary must differ");
  record.vault_status = vault.status;
  console.log(`Vault ${vaultId} is ${String(vault.status)}`);

  // 3. Live milestone claim -- only on an accepted vault.
  if (vault.status === "PENDING_ACCEPTANCE") {
    console.log(
      `The beneficiary must accept before anything can be claimed (window closes at unix ${String(vault.accept_deadline)}):\n` +
        `  genlayer account use shiporslash-founder\n` +
        `  genlayer write ${address} accept_vault_terms --args ${vaultId} --fees '<estimate-fees json>'\n` +
        `then re-run this script with SHIPORSLASH_ADDRESS=${address} SHIPORSLASH_VAULT_ID=${vaultId}.`,
    );
  } else if (vault.status === "ACTIVE" && Number(vault.tranches_done) === 0) {
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
    record.claim_status = fact("status", [claimReceipt.statusName, claimReceipt.status], claimReceipt.status, STATUS_BY_NUMBER);
  } else {
    console.log(`Nothing to claim: vault is ${String(vault.status)} with ${String(vault.tranches_done)} tranche(s) done.`);
  }

  // 4. Authoritative readbacks.
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
