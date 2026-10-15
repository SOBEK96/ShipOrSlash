/**
 * Strict receipt finality. A transaction hash coming back from a write proves
 * only that the transaction was submitted. A write is treated as having done
 * what the user asked only when ALL of the following hold:
 *
 *   status            ACCEPTED or FINALIZED   (consensus decided)
 *   execution result  FINISHED_WITH_RETURN    (the contract ran to a return,
 *                                              not an error or a timeout)
 *   consensus result  MAJORITY_AGREE          (validators agreed)
 *
 * Studio Next does not populate the SDK's `resultName`: its transaction record
 * carries the consensus result as `result_name` and as the number `result`,
 * and the status as a string. Each of the three facts is therefore read from
 * the named field when present, then the snake_case field, then the SDK's own
 * number-to-name map. If a name and a number are both present and disagree the
 * receipt is malformed -- it is never resolved in whichever direction would
 * have passed.
 */

export interface ReceiptLike {
  statusName?: string;
  status?: string | number;
  txExecutionResultName?: string;
  txExecutionResult?: string | number;
  resultName?: string;
  result_name?: string;
  result?: string | number;
  hash?: string;
  txId?: string;
}

export type ReceiptFailure = "NOT_DECIDED" | "EXECUTION_ERROR" | "NO_MAJORITY" | "MALFORMED";

export type ReceiptVerdict =
  | { ok: true; status: "ACCEPTED" | "FINALIZED" }
  | { ok: false; code: ReceiptFailure; message: string };

// These mirror genlayer-js's transactionsStatusNumberToName,
// executionResultNumberToName and transactionResultNumberToName.
export const STATUS_BY_NUMBER: Record<string, string> = {
  "0": "UNINITIALIZED", "1": "PENDING", "2": "PROPOSING", "3": "COMMITTING", "4": "REVEALING",
  "5": "ACCEPTED", "6": "UNDETERMINED", "7": "FINALIZED", "8": "CANCELED", "9": "APPEAL_REVEALING",
  "10": "APPEAL_COMMITTING", "11": "VALIDATORS_TIMEOUT", "12": "LEADER_TIMEOUT", "13": "LEADER_REVEALING",
};
export const EXEC_BY_NUMBER: Record<string, string> = {
  "0": "NOT_VOTED", "1": "FINISHED_WITH_RETURN", "2": "FINISHED_WITH_ERROR", "3": "TIMEOUT",
  "4": "NONDET_DISAGREE", "5": "DETERMINISTIC_VIOLATION",
};
export const RESULT_BY_NUMBER: Record<string, string> = {
  "0": "IDLE", "1": "MAJORITY_AGREE", "2": "MAJORITY_DISAGREE", "3": "MAJORITY_TIMEOUT",
  "4": "DETERMINISTIC_VIOLATION", "5": "NO_MAJORITY",
};

type Resolved = { value: string | undefined; conflict: boolean };

/** Reads one fact from its candidate fields; `conflict` when two disagree. */
function resolve(
  names: ReadonlyArray<unknown>,
  numeric: unknown,
  byNumber: Record<string, string>,
): Resolved {
  const found = new Set<string>();
  for (const n of names) {
    if (typeof n !== "string" || n === "") continue;
    // A numeric string ("5") in a name slot is a number, not a name.
    found.add(/^[0-9]+$/.test(n) ? (byNumber[n] ?? n) : n);
  }
  if (typeof numeric === "number" || (typeof numeric === "string" && /^[0-9]+$/.test(numeric))) {
    const mapped = byNumber[String(numeric)];
    if (mapped !== undefined) found.add(mapped);
  }
  if (found.size > 1) return { value: undefined, conflict: true };
  return { value: found.values().next().value as string | undefined, conflict: false };
}

const DECIDED = new Set(["ACCEPTED", "FINALIZED"]);

export function checkReceipt(r: ReceiptLike | null | undefined): ReceiptVerdict {
  if (!r || typeof r !== "object") {
    return { ok: false, code: "MALFORMED", message: "The network returned no receipt." };
  }
  const status = resolve([r.statusName, r.status], r.status, STATUS_BY_NUMBER);
  const exec = resolve([r.txExecutionResultName], r.txExecutionResult, EXEC_BY_NUMBER);
  const result = resolve([r.resultName, r.result_name], r.result, RESULT_BY_NUMBER);

  if (status.conflict || exec.conflict || result.conflict) {
    return { ok: false, code: "MALFORMED", message: "The receipt's status fields contradict each other." };
  }
  if (status.value === undefined || exec.value === undefined || result.value === undefined) {
    return {
      ok: false,
      code: "MALFORMED",
      message: "The receipt is missing its status, execution result or consensus result.",
    };
  }
  if (!DECIDED.has(status.value)) {
    return { ok: false, code: "NOT_DECIDED", message: `Consensus has not decided this transaction (status ${status.value}).` };
  }
  if (exec.value !== "FINISHED_WITH_RETURN") {
    return { ok: false, code: "EXECUTION_ERROR", message: `The contract did not return normally (${exec.value}).` };
  }
  if (result.value !== "MAJORITY_AGREE") {
    return { ok: false, code: "NO_MAJORITY", message: `Validators did not reach a majority (${result.value}).` };
  }
  return { ok: true, status: status.value as "ACCEPTED" | "FINALIZED" };
}

export class ReceiptError extends Error {
  readonly code: ReceiptFailure;
  constructor(code: ReceiptFailure, message: string) {
    super(message);
    this.name = "ReceiptError";
    this.code = code;
  }
}

/** Throws ReceiptError unless the receipt satisfies every finality condition. */
export function assertFinalReceipt<T extends ReceiptLike>(r: T | null | undefined): T {
  const v = checkReceipt(r);
  if (!v.ok) throw new ReceiptError(v.code, v.message);
  return r as T;
}
