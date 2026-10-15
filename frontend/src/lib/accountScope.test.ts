import { describe, expect, it } from "vitest";
import { AccountScopedState, canonicalAccount } from "./accountScope";

const A = "0x2bd806c97f0e00af1a1fc3328fa763a9269723c8";
const B = "0x81b637d8fcd2c6da6359e6963113a1170de795e4";

describe("canonicalAccount", () => {
  it.each([
    [A, A],
    [A.toUpperCase().replace("0X", "0x"), A],
    [`  ${A}  `, A],
    [null, null],
    [undefined, null],
    ["", null],
    ["0x123", null],
    ["not an address", null],
    [A + "0", null],
  ])("%j -> %j", (input, want) => {
    expect(canonicalAccount(input as string | null)).toBe(want);
  });
});

describe("AccountScopedState", () => {
  it("clears everything the instant the account changes", () => {
    const s = new AccountScopedState<number>();
    s.setAccount(A);
    s.set("vault:1", 10, A);
    s.set("vault:2", 20, A);
    expect(s.size).toBe(2);
    expect(s.setAccount(B)).toBe(true);
    expect(s.size).toBe(0);
    expect(s.get("vault:1", B)).toBeUndefined();
  });

  it("does not clear when the same account is re-set (case-insensitive)", () => {
    const s = new AccountScopedState<number>();
    s.setAccount(A);
    s.set("k", 1, A);
    expect(s.setAccount(A.replace("0x2b", "0x2B"))).toBe(false);
    expect(s.get("k")).toBe(1);
  });

  it("refuses writes tagged with a stale account", () => {
    const s = new AccountScopedState<number>();
    s.setAccount(A);
    s.setAccount(B);
    expect(s.set("k", 99, A)).toBe(false); // a late response for the old account
    expect(s.get("k", B)).toBeUndefined();
  });

  it("will not read another account's data even if asked", () => {
    const s = new AccountScopedState<number>();
    s.setAccount(A);
    s.set("k", 1, A);
    expect(s.get("k", B)).toBeUndefined();
  });

  it("treats an empty accountsChanged list as disconnect", () => {
    const s = new AccountScopedState<number>();
    s.handleAccountsChanged([A]);
    s.set("k", 1, A);
    expect(s.handleAccountsChanged([])).toBe(true);
    expect(s.current).toBeNull();
    expect(s.size).toBe(0);
    expect(s.set("k", 1, A)).toBe(false);
  });

  it("switches to the first account of accountsChanged", () => {
    const s = new AccountScopedState<number>();
    s.handleAccountsChanged([A]);
    s.handleAccountsChanged([B, A]);
    expect(s.current).toBe(B);
  });

  it("bumps the epoch on every real change and only then", () => {
    const s = new AccountScopedState<number>();
    const e0 = s.epoch;
    s.setAccount(A);
    s.setAccount(A);
    s.setAccount(B);
    expect(s.epoch).toBe(e0 + 2);
  });

  it("notifies subscribers on change", () => {
    const s = new AccountScopedState<number>();
    let n = 0;
    s.subscribe(() => n++);
    s.setAccount(A);
    s.set("k", 1, A);
    s.setAccount(B);
    expect(n).toBe(3);
  });

  it("rejects malformed accounts as no account", () => {
    const s = new AccountScopedState<number>();
    s.setAccount("garbage");
    expect(s.current).toBeNull();
    expect(s.set("k", 1, "garbage")).toBe(false);
  });

  it("deletes only for the current account", () => {
    const s = new AccountScopedState<number>();
    s.setAccount(A);
    s.set("k", 1, A);
    expect(s.delete("k", B)).toBe(false);
    expect(s.delete("k", A)).toBe(true);
  });
});
