/**
 * Strict receipt finality. A transaction hash coming back from a write proves
 * only that the transaction was submitted. A write is treated as having done
 * what the user asked only when ALL of the following hold:
 *
 *   statusName            ACCEPTED or FINALIZED   (consensus decided)
 *   txExecutionResultName FINISHED_WITH_RETURN    (the contract ran to a return,
 *                                                  not an error or a timeout)
 *   resultName            MAJORITY_AGREE          (validators agreed)
 *
 * Anything else is reported with the specific field that failed, so the console
 * can say why instead of "something went wrong".
 */

export interface ReceiptLike {
  statusName?: string;
  txExecutionResultName?: string;
  resultName?: string;
  hash?: string;
  txId?: string;
}

export type ReceiptVerdict =
  | { ok: true; status: "ACCEPTED" | "FINALIZED" }
  | { ok: false; code: ReceiptFailure; message: string };

export type ReceiptFailure =
  | "NOT_DECIDED"
  | "EXECUTION_ERROR"
  | "NO_MAJORITY"
  | "MALFORMED";

const DECIDED = new Set(["ACCEPTED", "FINALIZED"]);

export function checkReceipt(r: ReceiptLike | null | undefined): ReceiptVerdict {
  if (!r || typeof r !== "object") {
    return { ok: false, code: "MALFORMED", message: "The network returned no receipt." };
  }
  const status = r.statusName;
  const exec = r.txExecutionResultName;
  const result = r.resultName;
  if (typeof status !== "string" || typeof exec !== "string" || typeof result !== "string") {
    return { ok: false, code: "MALFORMED", message: "The receipt is missing its status, execution result or consensus result." };
  }
  if (!DECIDED.has(status)) {
    return { ok: false, code: "NOT_DECIDED", message: `Consensus has not decided this transaction (status ${status}).` };
  }
  if (exec !== "FINISHED_WITH_RETURN") {
    return { ok: false, code: "EXECUTION_ERROR", message: `The contract did not return normally (${exec}).` };
  }
  if (result !== "MAJORITY_AGREE") {
    return { ok: false, code: "NO_MAJORITY", message: `Validators did not reach a majority (${result}).` };
  }
  return { ok: true, status: status as "ACCEPTED" | "FINALIZED" };
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
