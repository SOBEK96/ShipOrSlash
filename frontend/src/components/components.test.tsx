import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ClaimTrancheDesk } from "./ClaimTrancheDesk";
import { Footer } from "./Footer";
import { MilestoneTracker } from "./MilestoneTracker";
import { ProtocolExplainer } from "./ProtocolExplainer";
import { SyncAlert } from "./SyncAlert";
import { VaultCreator } from "./VaultCreator";
import type { MilestoneStatus, VaultState, VerifierSources } from "@/lib/parse";

afterEach(cleanup);

const ADDR = "0x059c675971F5c095BD9aa4B7C942DF7287BbcDc6";
const mk = (over: Partial<VaultState> = {}): VaultState => ({
  vaultId: 1,
  status: "ACTIVE",
  funder: "0x2bd806c97f0e00af1a1fc3328fa763a9269723c8",
  beneficiary: "0x81b637d8fcd2c6da6359e6963113a1170de795e4",
  repoUrl: "https://github.com/sobek96/shiporslash",
  signerHash: "d8a87fdcd4224662af9b788cae845191b3bc64b8155eb124fdbe0d506e4fcf10",
  tagPrefix: "v",
  npmPackage: "@sobek96/shiporslash",
  dockerImage: "sobek96/shiporslash",
  feeds: ["https://a.example.org/", "https://b.example.net/", "https://c.example.io/"],
  deadline: 2_000_000_000,
  createdAt: 1_700_000_000,
  deposited: 5n * 10n ** 17n,
  released: 10n ** 17n,
  withdrawn: 0n,
  reclaimed: 0n,
  withdrawable: 10n ** 17n,
  unreleased: 4n * 10n ** 17n,
  tranchesDone: 1,
  attempts: 2,
  lastVerdict: 1,
  lastSourceCount: 3,
  lastAttemptAt: 1_700_000_100,
  lastMilestone: 1,
  tranches: [
    { milestoneId: 1, kind: "ALPHA", bps: 2000, status: "ACCEPTED", releaseTag: "v0.1.0-alpha.1", commitSha: "1".repeat(40), artifactDigest: `sha256:${"a".repeat(64)}`, verifiedTs: 1760000001, amount: 10n ** 17n },
    { milestoneId: 2, kind: "RC", bps: 3000, status: "PENDING", releaseTag: "", commitSha: "", artifactDigest: "", verifiedTs: 0, amount: 15n * 10n ** 16n },
    { milestoneId: 3, kind: "STABLE", bps: 5000, status: "LOCKED", releaseTag: "", commitSha: "", artifactDigest: "", verifiedTs: 0, amount: 25n * 10n ** 16n },
  ],
  ...over,
});

const ms = (id: 1 | 2 | 3, over: Partial<MilestoneStatus> = {}): MilestoneStatus => ({
  vaultId: 1,
  milestoneId: id,
  kind: (["ALPHA", "RC", "STABLE"] as const)[id - 1]!,
  bps: [2000, 3000, 5000][id - 1]!,
  status: id === 1 ? "ACCEPTED" : id === 2 ? "PENDING" : "LOCKED",
  releaseTag: "",
  commitSha: "",
  artifactDigest: "",
  previousTag: id === 2 ? "v0.1.0-alpha.1" : "",
  verifiedTs: 0,
  amount: 15n * 10n ** 16n,
  sourceUrls: ["https://a.example.org/milestone_2.json", "https://b.example.net/milestone_2.json", "https://c.example.io/milestone_2.json"],
  claimableNow: id === 2,
  ...over,
});

const sources: VerifierSources = {
  vaultId: 1,
  sources: [
    { slot: "A", role: "GitHub release + signed-commit verifier", baseUrl: "https://raw.githubusercontent.com/x/", host: "raw.githubusercontent.com", operator: "github" },
    { slot: "B", role: "Independent CI/CD status mirror", baseUrl: "https://cdn.jsdelivr.net/x/", host: "cdn.jsdelivr.net", operator: "jsdelivr" },
    { slot: "C", role: "Package artifact / registry mirror", baseUrl: "https://raw.githack.com/x/", host: "raw.githack.com", operator: "githack" },
  ],
  distinctHosts: 3,
  distinctOperators: 3,
  independent: true,
  quorum: 2,
  repoUrl: "https://github.com/sobek96/shiporslash",
  signerHash: "d8a87fdcd4224662af9b788cae845191b3bc64b8155eb124fdbe0d506e4fcf10",
  npmPackage: "@sobek96/shiporslash",
  dockerImage: "sobek96/shiporslash",
};

describe("SyncAlert", () => {
  const base = { lastSyncedAt: 1000, failedItems: [] as string[], error: null as string | null };

  it("is silent before the first read", () => {
    const { container } = render(<SyncAlert sync={{ ...base, phase: "idle" }} now={2000} onRetry={() => {}} />);
    expect(container.textContent).toBe("");
  });

  it("reports a healthy sync", () => {
    render(<SyncAlert sync={{ ...base, phase: "ok" }} now={31_000} onRetry={() => {}} />);
    expect(screen.getByRole("status").textContent).toMatch(/Synced 30s ago/);
  });

  it("names exactly the stale items on a partial read", () => {
    render(<SyncAlert sync={{ ...base, phase: "partial", failedItems: ["m2", "sources"] }} now={5000} onRetry={() => {}} />);
    const a = screen.getByRole("alert").textContent ?? "";
    expect(a).toMatch(/Partial read/);
    expect(a).toMatch(/tranche 2, verifier sources/);
    expect(a).toMatch(/last value received/);
  });

  it("says the chain is not answering when everything failed", () => {
    render(<SyncAlert sync={{ ...base, phase: "down", error: "fetch failed" }} now={61_000} onRetry={() => {}} />);
    const a = screen.getByRole("alert").textContent ?? "";
    expect(a).toMatch(/not answering/);
    expect(a).toMatch(/fetch failed/);
  });

  it("offers a retry", () => {
    const retry = vi.fn();
    render(<SyncAlert sync={{ ...base, phase: "down" }} now={0} onRetry={retry} />);
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(retry).toHaveBeenCalledOnce();
  });
});

describe("MilestoneTracker", () => {
  it("shows an empty state without a vault", () => {
    render(<MilestoneTracker vault={undefined} sources={undefined} milestones={{}} />);
    expect(screen.getByText(/Choose a vault/)).toBeTruthy();
  });

  it("renders every tranche with status and release tag", () => {
    render(<MilestoneTracker vault={mk()} sources={sources} milestones={{ 1: ms(1), 2: ms(2), 3: ms(3) }} />);
    expect(screen.getByText("v0.1.0-alpha.1")).toBeTruthy();
    expect(screen.getByText("ACCEPTED")).toBeTruthy();
    expect(screen.getByText("PENDING")).toBeTruthy();
    expect(screen.getByText("LOCKED")).toBeTruthy();
    expect(screen.getByText(/Tranche 2 · RC/)).toBeTruthy();
  });

  it("shows three hosts and their operators on the radar", () => {
    render(<MilestoneTracker vault={mk()} sources={sources} milestones={{ 1: ms(1), 2: ms(2), 3: ms(3) }} />);
    for (const host of ["raw.githubusercontent.com", "cdn.jsdelivr.net", "raw.githack.com"]) {
      expect(screen.getByText(host)).toBeTruthy();
    }
    expect(screen.getByText(/Independent\./)).toBeTruthy();
    expect(screen.getAllByText("Not probed")).toHaveLength(3);
  });

  it("states that the preview is not the verdict", () => {
    render(<MilestoneTracker vault={mk()} sources={sources} milestones={{ 2: ms(2) }} />);
    expect(screen.getByText(/Only the on-chain verdict moves funds/)).toBeTruthy();
  });

  it("reports the last on-chain attempt", () => {
    render(<MilestoneTracker vault={mk({ lastVerdict: 2, lastSourceCount: 1, attempts: 4, lastMilestone: 2 })} sources={sources} milestones={{ 2: ms(2) }} />);
    expect(screen.getByText(/retryable \(quorum not reached\)/)).toBeTruthy();
    expect(screen.getByText(/4 attempts so far/)).toBeTruthy();
  });

  it("flags non-independent sources", () => {
    render(<MilestoneTracker vault={mk()} sources={{ ...sources, independent: false }} milestones={{ 2: ms(2) }} />);
    expect(screen.getByText(/NOT independent/)).toBeTruthy();
  });
});

const deskProps = {
  vault: mk(),
  milestones: { 1: ms(1), 2: ms(2), 3: ms(3) },
  connected: true,
  busy: null as string | null,
  notice: null,
  nowSeconds: 1_900_000_000,
  onClaim: vi.fn(),
  onWithdraw: vi.fn(),
  onReclaim: vi.fn(),
  onTopUp: vi.fn(),
  onDismiss: vi.fn(),
};

describe("ClaimTrancheDesk", () => {
  it("lets the beneficiary verify and withdraw", () => {
    const onClaim = vi.fn();
    const onWithdraw = vi.fn();
    render(<ClaimTrancheDesk {...deskProps} role="beneficiary" onClaim={onClaim} onWithdraw={onWithdraw} />);
    fireEvent.click(screen.getByRole("button", { name: /Verify tranche 2/ }));
    expect(onClaim).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    expect(onWithdraw).toHaveBeenCalledOnce();
  });

  it("keeps a viewer read-only", () => {
    render(<ClaimTrancheDesk {...deskProps} role="viewer" />);
    expect((screen.getByRole("button", { name: /Verify tranche 2/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Withdraw" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not let the funder withdraw the beneficiary's funds", () => {
    render(<ClaimTrancheDesk {...deskProps} role="funder" />);
    expect((screen.getByRole("button", { name: "Withdraw" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables slashing until the deadline has passed", () => {
    render(<ClaimTrancheDesk {...deskProps} role="funder" />);
    expect((screen.getByRole("button", { name: /Slash unshipped/ }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    render(<ClaimTrancheDesk {...deskProps} role="funder" nowSeconds={2_000_000_001} />);
    expect((screen.getByRole("button", { name: /Slash unshipped/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables everything while a transaction is in flight", () => {
    render(<ClaimTrancheDesk {...deskProps} role="beneficiary" busy="Withdrawing" />);
    expect((screen.getByRole("button", { name: /Verify tranche 2/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Withdraw" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks a disconnected visitor to connect", () => {
    render(<ClaimTrancheDesk {...deskProps} role="viewer" connected={false} />);
    expect(screen.getByText(/Connect a wallet to act on this vault/)).toBeTruthy();
  });

  it("only offers top-up to the funder", () => {
    render(<ClaimTrancheDesk {...deskProps} role="beneficiary" />);
    expect(screen.queryByText(/Top up \(GEN\)/)).toBeNull();
    cleanup();
    render(<ClaimTrancheDesk {...deskProps} role="funder" />);
    expect(screen.getByText(/Top up \(GEN\)/)).toBeTruthy();
  });

  it("validates the top-up amount", () => {
    render(<ClaimTrancheDesk {...deskProps} role="funder" />);
    const input = screen.getByPlaceholderText("0.25");
    fireEvent.change(input, { target: { value: "0.0001" } });
    expect(screen.getByRole("alert").textContent).toMatch(/Minimum top-up/);
    fireEvent.change(input, { target: { value: "abc" } });
    expect(screen.getByRole("alert").textContent).toMatch(/Enter an amount/);
  });

  it("links a successful transaction to the explorer", () => {
    render(<ClaimTrancheDesk {...deskProps} role="beneficiary" notice={{ kind: "success", message: "Done.", hash: "0xabc" }} />);
    const a = screen.getByRole("link", { name: "View transaction" }) as HTMLAnchorElement;
    expect(a.href).toContain("/tx/0xabc");
  });

  it("explains a closed vault", () => {
    render(<ClaimTrancheDesk {...deskProps} role="funder" vault={mk({ status: "SLASHED" })} milestones={{ 1: ms(1), 2: ms(2, { claimableNow: false }) }} />);
    expect(screen.getByText(/was slashed/)).toBeTruthy();
  });
});

describe("VaultCreator", () => {
  const props = { account: "0x2bd806c97f0e00af1a1fc3328fa763a9269723c8", busy: null, onCreate: vi.fn(), nowSeconds: 1_800_000_000 };
  const submit = () => screen.getByRole("button", { name: /Create vault and deposit/ }) as HTMLButtonElement;

  it("starts disabled until a beneficiary is entered", () => {
    render(<VaultCreator {...props} />);
    expect(submit().disabled).toBe(true);
  });

  it("enables with a valid beneficiary and the default registry", async () => {
    render(<VaultCreator {...props} />);
    fireEvent.change(screen.getByPlaceholderText("0x…"), { target: { value: "0x81b637d8fcd2c6da6359e6963113a1170de795e4" } });
    await vi.waitFor(() => expect(submit().disabled).toBe(false));
  });

  it("rejects the funder as beneficiary", () => {
    render(<VaultCreator {...props} />);
    fireEvent.change(screen.getByPlaceholderText("0x…"), { target: { value: props.account } });
    expect(screen.getByRole("alert").textContent).toMatch(/different wallet/);
    expect(submit().disabled).toBe(true);
  });

  it("shows the exact tranche split", () => {
    render(<VaultCreator {...props} />);
    expect(screen.getByText(/last tranche absorbs/i).textContent).toMatch(/0\.1.*\(20%\).*0\.15.*\(30%\).*0\.25.*\(50%\)/);
  });

  it("explains a shared-operator mirror set", () => {
    render(<VaultCreator {...props} />);
    const slotB = screen.getByDisplayValue(/cdn\.jsdelivr\.net/);
    fireEvent.change(slotB, { target: { value: "https://api.github.com/repos/SOBEK96/ShipOrSlash/" } });
    expect(screen.getAllByRole("alert").map((a) => a.textContent).join(" ")).toMatch(/distinct operators/);
    expect(submit().disabled).toBe(true);
  });

  it("requires a deposit above the floor", () => {
    render(<VaultCreator {...props} />);
    fireEvent.change(screen.getByDisplayValue("0.5"), { target: { value: "0.0001" } });
    expect(screen.getAllByRole("alert").map((a) => a.textContent).join(" ")).toMatch(/Minimum deposit/);
  });

  it("asks a disconnected visitor to connect", () => {
    render(<VaultCreator {...props} account={null} />);
    expect(screen.getByText(/Connect a wallet to create a vault/)).toBeTruthy();
    expect(submit().disabled).toBe(true);
  });

  it("submits the committed registry with the deadline offset from now", async () => {
    const onCreate = vi.fn();
    render(<VaultCreator {...props} onCreate={onCreate} />);
    fireEvent.change(screen.getByPlaceholderText("0x…"), { target: { value: "0x81b637d8fcd2c6da6359e6963113a1170de795e4" } });
    await vi.waitFor(() => expect(submit().disabled).toBe(false));
    fireEvent.click(submit());
    expect(onCreate).toHaveBeenCalledOnce();
    const input = onCreate.mock.calls[0]![0];
    expect(input.deadline).toBe(1_800_000_000 + 30 * 86_400);
    expect(input.deposit).toBe(5n * 10n ** 17n);
    expect(input.signerHash).toBe("d8a87fdcd4224662af9b788cae845191b3bc64b8155eb124fdbe0d506e4fcf10");
    expect(input.tagPrefix).toBe("v");
  });
});

describe("static content", () => {
  it("explains the protocol in four cards", () => {
    render(<ProtocolExplainer />);
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(5); // section title + 4 cards
    expect(screen.getByText("Outages never punish")).toBeTruthy();
  });

  it("footer links the contract on the explorer", () => {
    render(<Footer contractAddress={ADDR} />);
    const a = screen.getByTitle(ADDR) as HTMLAnchorElement;
    expect(a.href).toBe(`https://explorer-studio-next.genlayer.com/address/${ADDR}`);
    expect(screen.getByText(/chain 61997/)).toBeTruthy();
  });
});
