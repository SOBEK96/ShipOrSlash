import { describe, expect, it } from "vitest";
import { ReceiptError, assertFinalReceipt, checkReceipt } from "./receipt";

const good = { statusName: "ACCEPTED", txExecutionResultName: "FINISHED_WITH_RETURN", resultName: "MAJORITY_AGREE" };

describe("strict receipt finality", () => {
  it.each(["ACCEPTED", "FINALIZED"])("accepts %s", (statusName) => {
    expect(checkReceipt({ ...good, statusName }).ok).toBe(true);
  });

  it.each([
    "PENDING",
    "PROPOSING",
    "COMMITTING",
    "REVEALING",
    "UNDETERMINED",
    "CANCELED",
    "LEADER_TIMEOUT",
    "VALIDATORS_TIMEOUT",
  ])("refuses an undecided status %s", (statusName) => {
    const v = checkReceipt({ ...good, statusName });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("NOT_DECIDED");
  });

  it.each(["FINISHED_WITH_ERROR", "NOT_VOTED", "TIMEOUT", "NONDET_DISAGREE", "DETERMINISTIC_VIOLATION"])(
    "refuses execution result %s even when accepted",
    (txExecutionResultName) => {
      const v = checkReceipt({ ...good, txExecutionResultName });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe("EXECUTION_ERROR");
    },
  );

  it.each(["MAJORITY_DISAGREE", "NO_MAJORITY", "MAJORITY_TIMEOUT", "DETERMINISTIC_VIOLATION", "IDLE", "AGREE"])(
    "refuses consensus result %s",
    (resultName) => {
      const v = checkReceipt({ ...good, resultName });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe("NO_MAJORITY");
    },
  );

  it.each([
    [null],
    [undefined],
    [{}],
    [{ statusName: "ACCEPTED" }],
    [{ ...good, resultName: undefined }],
    [{ ...good, txExecutionResultName: undefined }],
    [{ ...good, statusName: undefined }],
  ])("reports a malformed receipt %#", (r) => {
    const v = checkReceipt(r as never);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("MALFORMED");
  });

  it("assertFinalReceipt throws a typed error and returns good receipts", () => {
    expect(assertFinalReceipt(good)).toBe(good);
    expect(() => assertFinalReceipt({ ...good, statusName: "PENDING" })).toThrow(ReceiptError);
    try {
      assertFinalReceipt({ ...good, resultName: "NO_MAJORITY" });
    } catch (e) {
      expect((e as ReceiptError).code).toBe("NO_MAJORITY");
    }
  });
});
