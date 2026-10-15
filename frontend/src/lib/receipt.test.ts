import { describe, expect, it } from "vitest";
import { ReceiptError, assertFinalReceipt, checkReceipt } from "./receipt";

const good = { statusName: "ACCEPTED", txExecutionResultName: "FINISHED_WITH_RETURN", resultName: "MAJORITY_AGREE" };

describe("receipt shapes the network actually returns", () => {
  // Captured from Studio Next (tx 0x3fa8081e...): status is a string, the
  // consensus result is `result_name` / `result`, and `resultName` is absent.
  const studioRaw = {
    status: "ACCEPTED",
    result: 1,
    result_name: "MAJORITY_AGREE",
    txExecutionResult: 1,
    txExecutionResultName: "FINISHED_WITH_RETURN",
  };

  it("accepts the raw Studio Next transaction record", () => {
    expect(checkReceipt(studioRaw).ok).toBe(true);
  });

  it("accepts the SDK-normalised shape without resultName, via the numeric result", () => {
    const sdk = { statusName: "ACCEPTED", result: 1, txExecutionResult: 1, txExecutionResultName: "FINISHED_WITH_RETURN" };
    expect(checkReceipt(sdk).ok).toBe(true);
  });

  it("accepts a receipt that carries numbers only", () => {
    expect(checkReceipt({ status: 5, result: 1, txExecutionResult: 1 }).ok).toBe(true);
    expect(checkReceipt({ status: "7", result: "1", txExecutionResult: "1" }).ok).toBe(true);
  });

  it.each([
    [{ ...studioRaw, result: 5, result_name: undefined }, "NO_MAJORITY"],
    [{ ...studioRaw, result: 0, result_name: undefined }, "NO_MAJORITY"],
    [{ ...studioRaw, result: 2, result_name: undefined }, "NO_MAJORITY"],
    [{ ...studioRaw, txExecutionResult: 2, txExecutionResultName: undefined }, "EXECUTION_ERROR"],
    [{ ...studioRaw, txExecutionResult: 0, txExecutionResultName: undefined }, "EXECUTION_ERROR"],
    [{ ...studioRaw, status: 1 }, "NOT_DECIDED"],
    [{ ...studioRaw, status: "PENDING" }, "NOT_DECIDED"],
    [{ ...studioRaw, status: 6 }, "NOT_DECIDED"],
  ] as const)("refuses %# by number alone", (r, code) => {
    const v = checkReceipt(r as never);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe(code);
  });

  it("is malformed, not passed, when a name and a number contradict", () => {
    const v = checkReceipt({ ...studioRaw, result_name: "MAJORITY_AGREE", result: 5 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("MALFORMED");
    const w = checkReceipt({ ...studioRaw, status: "ACCEPTED", statusName: "PENDING" });
    expect(w.ok).toBe(false);
  });

  it("still requires all three facts to be present", () => {
    const { result, result_name, ...rest } = studioRaw;
    void result;
    void result_name;
    const v = checkReceipt(rest);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("MALFORMED");
  });

  it("number maps match the ones inside the installed genlayer-js", async () => {
    // genlayer-js does not export these maps, so read them from its bundle.
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(__dirname, "../../node_modules/genlayer-js/dist");
    const chunk = readdirSync(dir)
      .filter((f) => f.startsWith("chunk-") && f.endsWith(".js"))
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .find((src) => src.includes("var transactionResultNumberToName = {"));
    expect(chunk, "SDK chunk with the result map").toBeDefined();
    const grab = (name: string): Record<string, string> => {
      const m = new RegExp(`var ${name} = \\{([^}]*)\\}`).exec(chunk!);
      expect(m, name).not.toBeNull();
      const out: Record<string, string> = {};
      for (const row of m![1]!.matchAll(/"(\d+)":\s*"([A-Z_]+)"/g)) out[row[1]!] = row[2]!;
      return out;
    };
    const { RESULT_BY_NUMBER, STATUS_BY_NUMBER, EXEC_BY_NUMBER } = await import("./receipt");
    expect(RESULT_BY_NUMBER).toEqual(grab("transactionResultNumberToName"));
    expect(STATUS_BY_NUMBER).toEqual(grab("transactionsStatusNumberToName"));
    expect(EXEC_BY_NUMBER).toEqual(grab("executionResultNumberToName"));
    expect(Object.keys(RESULT_BY_NUMBER)).toHaveLength(6);
  });
});

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

describe("deploy script stays in step with the console", () => {
  it("uses the same number-to-name maps as receipt.ts", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../../../deploy/deploy_ship_or_slash.ts"), "utf8");
    const grab = (name: string): Record<string, string> => {
      const m = new RegExp(`const ${name}: Record<string, string> = (\\{.*?\\});`).exec(src);
      expect(m, `${name} in deploy script`).not.toBeNull();
      return JSON.parse(m![1]!) as Record<string, string>;
    };
    const { RESULT_BY_NUMBER, STATUS_BY_NUMBER, EXEC_BY_NUMBER } = await import("./receipt");
    expect(grab("RESULT_BY_NUMBER")).toEqual(RESULT_BY_NUMBER);
    expect(grab("STATUS_BY_NUMBER")).toEqual(STATUS_BY_NUMBER);
    expect(grab("EXEC_BY_NUMBER")).toEqual(EXEC_BY_NUMBER);
  });
});
