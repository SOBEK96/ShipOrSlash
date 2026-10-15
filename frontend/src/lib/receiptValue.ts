/**
 * Reading what a write RETURNED, from its receipt.
 *
 * `create_vault` returns the new vault's id. Guessing that id from the global
 * vault count after the fact is a client-side race: if anyone else created a
 * vault in the meantime the count points at theirs. The transaction's own
 * receipt carries the leader's return value, so that is what is read.
 *
 * The SDK hands the leader receipt back in more than one shape depending on how
 * the receipt was requested, so every shape seen on Studio Next is accepted:
 *
 *   raw RPC record         leader_receipt[i].result  = "AAk="  (base64)
 *   SDK, fullTransaction   result = { raw: "AAk=", status, payload: { raw: [9], readable: "1" } }
 *   SDK, default           result = { status: "return", payload: { readable: "1" } }
 *
 * The first byte of the raw form is a result code (0 = return); the rest is
 * GenLayer calldata. A value that is not a non-negative integer, or whose
 * execution did not return, is reported as a failure rather than coerced.
 */

export type ReturnRead =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

export type IdRead = { ok: true; id: number } | { ok: false; reason: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

function bytesFromBase64(b64: string): Uint8Array | null {
  try {
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
    const bin = atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function decodeCalldata(bytes: Uint8Array): Promise<unknown> {
  const sdk = (await import("genlayer-js")) as unknown as {
    abi: { calldata: { decode(b: Uint8Array): unknown } };
  };
  return sdk.abi.calldata.decode(bytes);
}

function leaderEntry(receipt: unknown): Obj | null {
  if (!isObj(receipt)) return null;
  const cd = receipt.consensus_data ?? receipt.consensusData;
  if (!isObj(cd)) return null;
  const lr = cd.leader_receipt ?? cd.leaderReceipt;
  const list = (Array.isArray(lr) ? lr : [lr]).filter((e): e is Obj => isObj(e) && "result" in e);
  // The list also holds each validator's own receipt, which can be an error or
  // an `idle` vote. Only an entry explicitly marked as the leader's is read;
  // an unmarked list is accepted only when it has exactly one entry.
  const marked = list.filter((e) => e.mode === "leader");
  if (marked.length === 1) return marked[0]!;
  if (marked.length === 0 && list.length === 1 && list[0]!.mode === undefined) return list[0]!;
  return null;
}

/** The value the leader's execution returned, or why it cannot be read. */
export async function leaderReturn(receipt: unknown): Promise<ReturnRead> {
  const entry = leaderEntry(receipt);
  if (!entry) return { ok: false, reason: "The receipt carries no leader result." };
  const exec = entry.execution_result ?? entry.executionResult;
  if (typeof exec === "string" && exec !== "SUCCESS") {
    return { ok: false, reason: `The leader's execution ended ${exec}.` };
  }
  const result = entry.result;

  // 1. raw base64 string: one result-code byte, then calldata.
  if (typeof result === "string") {
    const bytes = bytesFromBase64(result);
    if (!bytes || bytes.length < 1) return { ok: false, reason: "The leader result is not valid base64." };
    if (bytes[0] !== 0) return { ok: false, reason: `The leader result code is ${bytes[0]}, not a return.` };
    try {
      return { ok: true, value: await decodeCalldata(bytes.subarray(1)) };
    } catch {
      return { ok: false, reason: "The leader result is not valid calldata." };
    }
  }

  if (isObj(result)) {
    if (result.status !== undefined && result.status !== "return") {
      return { ok: false, reason: `The leader result status is ${String(result.status)}.` };
    }
    // 2. object carrying the raw base64.
    if (typeof result.raw === "string") {
      return leaderReturn({ consensus_data: { leader_receipt: [{ result: result.raw, execution_result: "SUCCESS" }] } });
    }
    const payload = result.payload;
    if (isObj(payload)) {
      // 3. calldata bytes without the result-code byte.
      if (Array.isArray(payload.raw) && payload.raw.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
        try {
          return { ok: true, value: await decodeCalldata(Uint8Array.from(payload.raw as number[])) };
        } catch {
          return { ok: false, reason: "The leader payload is not valid calldata." };
        }
      }
      // 4. only the human-readable form survives: accept it for plain integers.
      if (typeof payload.readable === "string" && /^(0|[1-9][0-9]*)$/.test(payload.readable)) {
        return { ok: true, value: BigInt(payload.readable) };
      }
    }
  }
  return { ok: false, reason: "The leader result is in a shape this console does not recognise." };
}

/** The vault id `create_vault` returned. Refuses anything that is not a
 * positive integer that fits a JavaScript number. */
export async function vaultIdFromReceipt(receipt: unknown): Promise<IdRead> {
  const r = await leaderReturn(receipt);
  if (!r.ok) return r;
  const v = r.value;
  const big = typeof v === "bigint" ? v : typeof v === "number" && Number.isInteger(v) ? BigInt(v) : null;
  if (big === null) return { ok: false, reason: "create_vault did not return an integer." };
  if (big < 1n || big > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "create_vault returned an out-of-range id." };
  return { ok: true, id: Number(big) };
}
