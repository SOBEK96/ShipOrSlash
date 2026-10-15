/**
 * Choosing a vault deadline that the contract will accept.
 *
 * The contract requires  now_block + 1 day <= deadline <= now_block + 5 years,
 * where now_block is the clock of the block that EXECUTES the transaction. A
 * client that signs `now + 1 day` is already late by the time consensus runs
 * (seconds to minutes), so a one-day vault built from the client's own clock
 * is rejected -- on the boundary, by design. Two corrections:
 *
 *   - read the chain's clock and use the later of it and the client's, so a
 *     client whose clock runs behind the chain does not under-shoot;
 *   - add a buffer on the near side, so latency and drift of up to the buffer
 *     do not push the deadline under the minimum.
 *
 * The contract's bounds are unchanged. The minimum window protects the
 * beneficiary from a funder who creates a vault and slashes it before anything
 * can ship, so it is held at one full day and the allowance for skew is paid by
 * the caller instead.
 */

import { MAX_WINDOW_S } from "./protocol";

/** Default allowance for client/chain clock drift and consensus latency. */
export const DEADLINE_SKEW_BUFFER_S = 3_600;

export interface DeadlineInput {
  days: number;
  /** Client wall clock, whole seconds. */
  clientNow: number;
  /** The chain's latest block time, or null when it could not be read. */
  chainNow: number | null;
  bufferS?: number;
}

/** The deadline to submit: later-of-clocks + days + buffer, never beyond the
 * contract's five-year ceiling measured from the same base. */
export function computeDeadline({ days, clientNow, chainNow, bufferS = DEADLINE_SKEW_BUFFER_S }: DeadlineInput): number {
  if (!Number.isInteger(days) || days < 1) throw new RangeError("days must be a whole number of at least 1");
  const base = Math.max(clientNow, chainNow ?? 0);
  // Block time only moves forward, so a ceiling measured from the earlier
  // `base` is always satisfied by the later block that runs the transaction.
  return Math.min(base + days * 86_400 + Math.max(0, bufferS), base + MAX_WINDOW_S);
}

type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

/** The latest block's timestamp in seconds, or null if it cannot be read. */
export async function fetchChainTime(
  rpcUrl: string,
  fetcher: Fetcher = (u, i) => fetch(u, i) as unknown as ReturnType<Fetcher>,
): Promise<number | null> {
  try {
    const res = await fetcher(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { timestamp?: unknown } | null };
    const ts = body?.result?.timestamp;
    if (typeof ts !== "string" || !/^0x[0-9a-fA-F]+$/.test(ts)) return null;
    const n = Number.parseInt(ts, 16);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
