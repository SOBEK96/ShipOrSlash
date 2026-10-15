import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { leaderReturn, vaultIdFromReceipt } from "./receiptValue";

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(__dirname, "__fixtures__", name), "utf8")) as Record<string, unknown>;

// Real receipts for create_vault, captured from Studio Next (vault id 1).
const FULL = fixture("create_vault_receipt.full.json");
const DEFAULT = fixture("create_vault_receipt.default.json");

const wrap = (...entries: unknown[]) => ({ consensus_data: { leader_receipt: entries } });
const leader = (result: unknown, extra: Record<string, unknown> = {}) => ({
  mode: "leader",
  result,
  execution_result: "SUCCESS",
  ...extra,
});

describe("vault id from a real create_vault receipt", () => {
  it("reads it from the SDK's fullTransaction shape (raw calldata)", async () => {
    expect(await vaultIdFromReceipt(FULL)).toEqual({ ok: true, id: 1 });
  });

  it("reads it from the SDK's default shape (readable payload)", async () => {
    expect(await vaultIdFromReceipt(DEFAULT)).toEqual({ ok: true, id: 1 });
  });

  it("does not read a validator's receipt: the leader entry is chosen by mode", async () => {
    // Put the (error) validator entry first: it must be skipped, not used.
    const entries = (FULL.consensus_data as { leader_receipt: unknown[] }).leader_receipt;
    const reordered = wrap(entries[1], entries[0]);
    expect(await vaultIdFromReceipt(reordered)).toEqual({ ok: true, id: 1 });
  });
});

describe("leaderReturn: the shapes the SDK produces", () => {
  it("decodes raw base64: result byte then calldata", async () => {
    // 00 = return, 0x29 = positive int 5 (5 << 3 | 1)
    const r = await leaderReturn(wrap(leader("ACk=")));
    expect(r).toEqual({ ok: true, value: 5n });
  });

  it("decodes an object carrying raw base64", async () => {
    const r = await leaderReturn(wrap(leader({ raw: "AAk=", status: "return", payload: { raw: [9], readable: "1" } })));
    expect(r).toEqual({ ok: true, value: 1n });
  });

  it("decodes payload.raw (calldata without the result byte)", async () => {
    const r = await leaderReturn(wrap(leader({ status: "return", payload: { raw: [9] } })));
    expect(r).toEqual({ ok: true, value: 1n });
  });

  it("accepts the readable form only for plain non-negative integers", async () => {
    expect(await leaderReturn(wrap(leader({ status: "return", payload: { readable: "42" } })))).toEqual({ ok: true, value: 42n });
    for (const bad of ["01", "-1", "1.0", "1e3", "'x'", "{'a': 1}", "", " 1"]) {
      const r = await leaderReturn(wrap(leader({ status: "return", payload: { readable: bad } })));
      expect(r.ok, bad).toBe(false);
    }
  });

  it("accepts camelCase container keys", async () => {
    const r = await leaderReturn({ consensusData: { leaderReceipt: [leader("AAk=")] } });
    expect(r.ok).toBe(true);
  });
});

describe("vaultIdFromReceipt refuses what it cannot be sure of", () => {
  it.each([
    ["no receipt", null],
    ["not an object", "0xabc"],
    ["no consensus data", {}],
    ["empty leader list", wrap()],
    ["only validator entries", wrap({ mode: "validator", result: "AAk=", execution_result: "SUCCESS" })],
    ["two leader entries", wrap(leader("AAk="), leader("ACk="))],
    ["execution error", wrap(leader("AAk=", { execution_result: "ERROR" }))],
    ["user-error result code", wrap(leader("AQk="))],
    ["not base64", wrap(leader("***"))],
    ["empty result", wrap(leader(""))],
    ["error status object", wrap(leader({ status: "contract_error", payload: "idle" }))],
    ["unrecognised object", wrap(leader({ hello: "world" }))],
  ])("%s", async (_name, receipt) => {
    const r = await vaultIdFromReceipt(receipt);
    expect(r.ok).toBe(false);
  });

  it("rejects a non-integer return", async () => {
    // 0x20 is the calldata tag for an empty string (type 4, length 0): a str, not an int
    const r = await vaultIdFromReceipt(wrap(leader("ACA=")));
    expect(r.ok).toBe(false);
  });

  it("rejects id 0 and ids beyond the safe integer range", async () => {
    expect((await vaultIdFromReceipt(wrap(leader({ status: "return", payload: { readable: "0" } })))).ok).toBe(false);
    expect((await vaultIdFromReceipt(wrap(leader({ status: "return", payload: { readable: "9007199254740993" } })))).ok).toBe(false);
  });

  it("never falls back to a count: a missing value is a failure, not a guess", async () => {
    const r = await vaultIdFromReceipt({ consensus_data: { leader_receipt: [] }, vault_count: 7 });
    expect(r).toMatchObject({ ok: false });
  });
});
