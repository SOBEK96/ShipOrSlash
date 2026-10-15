import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cumEntitlement, nextReleaseAmount, projectPending, trancheAmounts } from "./protocol";

/**
 * tests/vectors/tranche_parity.json is produced by running the real contract
 * (pytest: test_parity_vectors_file_is_current keeps it exact). Replaying it
 * here proves the TypeScript helpers compute what the contract computes, and
 * not merely what another TypeScript function thinks it should.
 */
interface Step {
  tranche: 1 | 2 | 3;
  deposited: string;
  released_before: string;
  projected_all: string[];
  projected: string;
  preview: string;
  paid: string;
}
interface Scenario {
  deposit: string;
  topups: { after: number; amount: string }[];
  steps: Step[];
}

const doc = JSON.parse(
  readFileSync(join(__dirname, "../../../tests/vectors/tranche_parity.json"), "utf8"),
) as { scenarios: Scenario[] };

describe("contract-generated tranche vectors", () => {
  it("has scenarios with and without top-ups", () => {
    expect(doc.scenarios.length).toBeGreaterThanOrEqual(10);
    expect(doc.scenarios.some((s) => s.topups.length === 0)).toBe(true);
    expect(doc.scenarios.some((s) => s.topups.length > 0)).toBe(true);
  });

  doc.scenarios.forEach((sc, idx) => {
    describe(`scenario ${idx}: deposit ${sc.deposit}, ${sc.topups.length} top-up(s)`, () => {
      sc.steps.forEach((st) => {
        it(`tranche ${st.tranche}: TS payout equals the contract's preview, projection and payout`, () => {
          const deposited = BigInt(st.deposited);
          const released = BigInt(st.released_before);
          const got = nextReleaseAmount(deposited, released, st.tranche);
          expect(got).toBe(BigInt(st.preview));
          expect(got).toBe(BigInt(st.projected));
          expect(got).toBe(BigInt(st.paid));
        });

        it(`tranche ${st.tranche}: pending projection matches every tranche the contract displayed`, () => {
          const deposited = BigInt(st.deposited);
          const released = BigInt(st.released_before);
          const pending = projectPending(deposited, released, st.tranche - 1);
          for (let k = 1; k <= 3; k++) {
            const got = pending[k - 1];
            if (k < st.tranche) expect(got).toBeNull();
            else expect(got).toBe(BigInt(st.projected_all[k - 1]!));
          }
        });
      });

      it("pays the whole of every deposit and top-up, exactly", () => {
        const total = BigInt(sc.deposit) + sc.topups.reduce((a, t) => a + BigInt(t.amount), 0n);
        expect(sc.steps.reduce((a, s) => a + BigInt(s.paid), 0n)).toBe(total);
      });
    });
  });

  it("no-top-up scenarios pay exactly trancheAmounts(deposit)", () => {
    for (const sc of doc.scenarios.filter((s) => s.topups.length === 0)) {
      const want = trancheAmounts(BigInt(sc.deposit));
      expect(sc.steps.map((s) => BigInt(s.paid))).toEqual(want);
    }
  });
});

describe("floor division parity", () => {
  // Python's // floors; BigInt / truncates toward zero. For the non-negative
  // amounts the protocol handles they are the same operation. Prove it against
  // an independent floor built from the remainder.
  const floorDiv = (a: bigint, b: bigint) => (a - (((a % b) + b) % b)) / b;

  it.each([0n, 1n, 9_999n, 10_000n, 10_001n, 10n ** 15n + 1n, 10n ** 18n - 1n, 2n ** 64n + 1n, 2n ** 128n - 1n])(
    "cumEntitlement(%s) equals floor(deposit * bps / 10000) for every tranche",
    (d) => {
      for (const [k, bps] of [
        [1, 2000n],
        [2, 5000n],
        [3, 10_000n],
      ] as const) {
        expect(cumEntitlement(d, k)).toBe(floorDiv(d * bps, 10_000n));
      }
    },
  );

  it("the last tranche absorbs every remainder, for 2000 pseudo-random deposits", () => {
    let x = 0x9e3779b97f4a7c15n;
    for (let i = 0; i < 2000; i++) {
      x = (x * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      const d = (x % 10n ** 21n) + 10n ** 15n;
      const [a, b, c] = trancheAmounts(d);
      expect(a + b + c).toBe(d);
      expect(a).toBe(floorDiv(d * 2000n, 10_000n));
      expect(c).toBeGreaterThanOrEqual(d / 2n);
    }
  });

  it("after a top-up the next tranche pays its catch-up share, not its nominal one", () => {
    // 1 GEN deposited, tranche 1 paid at that deposit (0.2), then topped up to 2 GEN.
    const released = 2n * 10n ** 17n;
    const now = 2n * 10n ** 18n;
    // Entitlement after tranche 2 is 50% of 2 GEN = 1.0, minus the 0.2 already paid.
    expect(nextReleaseAmount(now, released, 2)).toBe(8n * 10n ** 17n);
    // The nominal share, 30% of 2 GEN, would be 0.6: the shortfall the audit found.
    expect(cumEntitlement(now, 2) - cumEntitlement(now, 1)).toBe(6n * 10n ** 17n);
    // Once tranche 2 has paid (released = 1.0), tranche 3 pays the rest: 2.0 - 1.0.
    expect(nextReleaseAmount(now, released + 8n * 10n ** 17n, 3)).toBe(10n ** 18n);
  });
});
