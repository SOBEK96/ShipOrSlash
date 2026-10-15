/**
 * Account-scoped, keyed state.
 *
 * Every per-user panel (my vaults, my claims, my withdrawable balance) is keyed
 * by the connected wallet address. The failure this exists to prevent: the user
 * switches account in the wallet, an in-flight read for the OLD account lands
 * after the switch, and the new account's panel briefly shows the old account's
 * numbers. Two rules close it:
 *
 *   1. `setAccount` / `handleAccountsChanged` clear everything immediately when
 *      the address changes -- there is no frame where old data is visible under
 *      a new address.
 *   2. Writes are tagged with the account that requested them. A write for an
 *      account that is no longer current is refused, so a late response cannot
 *      repopulate a scope that has already moved on.
 */

export function canonicalAccount(a: string | null | undefined): string | null {
  if (!a) return null;
  const s = a.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(s) ? s : null;
}

export class AccountScopedState<T> {
  private account: string | null = null;
  private data = new Map<string, T>();
  private epochCounter = 0;
  private listeners = new Set<() => void>();

  get current(): string | null {
    return this.account;
  }

  /** Bumps on every account change; lets callers discard stale async work. */
  get epoch(): number {
    return this.epochCounter;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Returns true when the account actually changed (and state was cleared). */
  setAccount(next: string | null | undefined): boolean {
    const canon = canonicalAccount(next);
    if (canon === this.account) return false;
    this.account = canon;
    this.data.clear();
    this.epochCounter += 1;
    this.emit();
    return true;
  }

  /** EIP-1193 `accountsChanged` payload. An empty list means disconnected. */
  handleAccountsChanged(accounts: readonly string[] | null | undefined): boolean {
    return this.setAccount(accounts && accounts.length > 0 ? accounts[0] : null);
  }

  get(key: string, forAccount: string | null | undefined = this.account): T | undefined {
    const canon = canonicalAccount(forAccount);
    if (canon === null || canon !== this.account) return undefined;
    return this.data.get(key);
  }

  /** Refused (returns false) unless `forAccount` is still the current account. */
  set(key: string, value: T, forAccount: string | null | undefined): boolean {
    const canon = canonicalAccount(forAccount);
    if (canon === null || canon !== this.account) return false;
    this.data.set(key, value);
    this.emit();
    return true;
  }

  delete(key: string, forAccount: string | null | undefined = this.account): boolean {
    const canon = canonicalAccount(forAccount);
    if (canon === null || canon !== this.account) return false;
    const had = this.data.delete(key);
    if (had) this.emit();
    return had;
  }

  keys(): string[] {
    return Array.from(this.data.keys());
  }

  get size(): number {
    return this.data.size;
  }
}
