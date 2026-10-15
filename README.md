# ShipOrSlash

**Milestone-bound token vesting and a code-verified treasury, as a GenLayer Intelligent Contract.**

Calendar vesting pays founders who ship nothing. ShipOrSlash escrows native GEN in a
vault and releases it in three fixed tranches (20% / 30% / 50%), each unlocked only
when two of three independent verifier mirrors corroborate a signed, CI-passing,
published SemVer release. Tranches that are not shipped by the vault deadline can be
slashed back to the funder.

## Status (read this first)

| Item | State |
|---|---|
| Contract (`contracts/ship_or_slash.py`) | Written, linted, type-checked |
| Contract tests | **586 passed** (`pytest`), 8/8 hand-made mutants killed |
| Frontend | `tsc`, `eslint --max-warnings 0`, `next build` clean; **430 vitest passed**; `npm audit`: **0 vulnerabilities** |
| Deployed to Studio Next | **Yes**, `0x059c675971F5c095BD9aa4B7C942DF7287BbcDc6`, tx `0x590a27da…f2a` `FINALIZED`; on-chain source is byte-identical to the repo file |
| Live readbacks | `get_constants`, `get_protocol_state`, `whoami` verified live (see `deployments/studio-next.json`) |
| Mock feeds committed | Yes, locally, commit `d332a2ed3f52ebe83c99233960a37598a41f96a4` |
| Mock feeds pushed to GitHub, CDN HTTP 200 on all 3 hosts | **No, not done** |
| Live vault seed (0.5 GEN) and live `claim_milestone` | **No, not done.** It needs the feeds reachable on the three CDN hosts, which needs the push. `vault_id`, `seed_tx`, `claim_tx` are `null` in the deployment record rather than invented |

The unfinished steps are mechanical and are listed under [Finishing the live run](#finishing-the-live-run).

## How it works

```
funder ──create_vault(value)──▶ ┌────────────── ShipOrSlash vault ──────────────┐
                                │ immutable registry: repo, signer hash,        │
                                │ SemVer prefix, npm/docker targets, 3 mirrors  │
                                │ T1 ALPHA 20%  T2 RC 30%  T3 STABLE 50%        │
                                └───────────────┬───────────────────────────────┘
beneficiary/funder ──claim_milestone(n)──▶ 3 mirrors fetched ──▶ 2-of-3 quorum
                                                  │ VERIFIED  → tranche released
                                                  │ REJECTED  → nothing moves
                                                  └ RETRYABLE → nothing moves, no penalty
beneficiary ──withdraw_released──▶ pulls what was released
funder ──reclaim_unreleased (after deadline)──▶ slashes what was not shipped
```

### Invariants the contract enforces

1. **No float anywhere.** State, views, arithmetic and the clock are `int`/`str`/`bool`/`list`/`dict`.
   Shares are integer basis points; amounts are integer wei, returned as decimal strings. The block
   clock is built from `timedelta.days`/`.seconds` so `datetime.timestamp()` (a float) is never called.
   A test walks the contract's AST and fails on any float constant, `/`, or `float`.
2. **Immutable registry.** `create_vault` commits the repository (GitHub/GitLab only), the sha256 of
   the signer's GPG fingerprint, the tag prefix, npm/docker targets and the three mirror base URLs.
   There is no setter; a test asserts none exists.
3. **Three hosts, three operators.** Mirrors must be https, DNS-named (no IP/localhost/internal
   suffixes, no credentials/port/query), on three distinct hostnames *and* three distinct operators
   (`raw.githubusercontent.com` and `api.github.com` are two hosts but one operator).
4. **Deterministic tranches.** Entitlement after tranche *k* is `deposited * CUM_BPS[k] // 10000`; the
   last tranche is the exact remainder, so no dust is stranded. Every tranche must round to > 0.
5. **Fault-tolerant five-step `_aggregate`.** Payload is exactly
   `{verdict, milestone_id, source_count, release_tag, verified_ts}`:
   - fewer than 2 sources answered → `2` QUORUM_FAILURE (retryable);
   - ≥ 2 sources confirm the same `(tag, commit)` → `1` VERIFIED;
   - ≥ 2 sources report failure or a missing tag → `0` REJECTED;
   - otherwise, `2` if the unreachable source could still complete a 2-of-3 quorum
     (for example 1 CONFIRMED + 1 × 404 + 1 × outage), else `0`.
   Non-2xx other than 404/410, unparsable or oversized bodies are an *outage*, never a rejection.
   CI still running or a package not yet published counts as *missing* (lag), not *failed*.
6. **No outage slashing.** A retryable or rejected attempt only increments an informational counter.
7. **Capital preservation.** Unreleased tranches stay in escrow; releases are pulled
   (`withdraw_released`), debited before the transfer is queued and restored if queuing fails.

### Validators

`claim_milestone` uses `gl.vm.run_nondet` with a custom validator. There is no LLM: the leader and
each validator independently fetch the same three files and aggregate. A validator agrees only if the
milestone and verdict match and, for VERIFIED, the release tag matches. It disagrees if its own view is
a retryable outage while the leader claims VERIFIED, so a lagging validator can cost liveness but never
safety.

### SemVer rules

Strict SemVer 2.0.0 without build metadata, with the vault's prefix (`""` or `v`) required exactly.
Tranche 1 needs an `-alpha`/`-beta` pre-release, tranche 2 an `-rc`, tranche 3 a stable ≥ 1.0.0.
Each tranche's version must strictly outrank the previous one by SemVer precedence, so a tag cannot be
reused.

## Honest limitations

- **GPG verification is attested, not performed.** A contract cannot check a GPG signature against a
  commit it cannot fetch. The mirrors attest `signature_verified` and the signer's fingerprint hash;
  the contract requires 2-of-3 independent operators to agree. That is only as strong as those
  operators.
- **The mirror files in `deployments/mock_feeds` are synthetic.** The repository, tags, commits, signer
  and package digests are made up and every record carries `"mock": true`. They demonstrate the
  protocol; they are not real releases.
- **Operator identity is a heuristic.** Known suffixes are mapped to an operator; anything else falls
  back to its last two DNS labels, which is wrong for multi-part public suffixes such as `co.uk`.
- **"Streaming" is pull payment.** Released tranches are withdrawn in one pull; there is no time-based
  linear stream.
- **Direct-mode tests are not consensus.** pytest exercises the leader function and the captured
  validator via `run_validator`. Multi-validator consensus is only exercised live.
- **A late claim still wins.** If the beneficiary ships after the deadline but before the funder calls
  `reclaim_unreleased`, the claim succeeds. That is deliberate: slashing is the funder's action.
- **Third-party read of mirrors from the browser** (the radar preview) needs the mirror to allow CORS.
  The preview is not consensus and moves no funds.

## Layout

```
contracts/ship_or_slash.py        the Intelligent Contract
tests/                            pytest direct-mode suite (586 tests)
deployments/mock_feeds/{a,b,c}/   commit-pinned synthetic milestone records
deployments/studio-next.json      authoritative deployment record and readbacks
deployments/ship_or_slash_abi.json  schema read from the deployed contract
deploy/deploy_ship_or_slash.ts    deploy + seed + live claim + readbacks
frontend/                         Next.js 16.4.1 + Tailwind 4 static console (430 tests)
scripts/gen_mock_feeds.py         regenerates the fixtures
```

## Reproduce

```bash
# contract
uv venv --python 3.12 && uv pip install --prerelease=allow -r requirements-dev.txt
export GENVM_VERSION=v0.6.0-rc8   # the cached tree that still ships the pinned runner
.venv/bin/genvm-lint check contracts/ship_or_slash.py
.venv/bin/genvm-lint typecheck contracts/ship_or_slash.py
.venv/bin/python -m pytest tests -q

# frontend
cd frontend && npm install
npx tsc --noEmit && npx eslint --max-warnings 0 . && npx vitest run && npx next build
npm audit --registry=https://registry.npmjs.org
```

`GENVM_VERSION` matters: the pinned runner `py-genlayer:5jycge…` ships in the v0.6.0-rc3…rc8 trees
and not in rc9, and without the pin the linter and test harness pick the newest cached tree and fail
to find it. `tests/conftest.py` sets it for pytest.

## Finishing the live run

1. Push the feeds commit and check all three hosts return 200 with the expected JSON:
   ```bash
   git push -u origin main
   P=d332a2ed3f52ebe83c99233960a37598a41f96a4
   curl -sI https://raw.githubusercontent.com/SOBEK96/ShipOrSlash/$P/deployments/mock_feeds/a/milestone_1.json | head -1
   curl -sI https://cdn.jsdelivr.net/gh/SOBEK96/ShipOrSlash@$P/deployments/mock_feeds/b/milestone_1.json | head -1
   curl -sI https://raw.githack.com/SOBEK96/ShipOrSlash/$P/deployments/mock_feeds/c/milestone_1.json | head -1
   ```
2. Seed the vault and claim, reusing the deployed contract:
   ```bash
   genlayer account use shiporslash-deployer
   SHIPORSLASH_ADDRESS=0x059c675971F5c095BD9aa4B7C942DF7287BbcDc6 \
   SHIPORSLASH_DEPLOY_TX=0x590a27da1f784b5612ffe0075de73f53b232c396e28911f51b41911872813f2a \
   SHIPORSLASH_FOUNDER=0xE24e3cD8f1b7dC8fBC5718F16334b89f88bdA670 \
   SHIPORSLASH_FEED_PIN=$P genlayer deploy
   ```
   Deploying needs an explicit fee object on Studio Next (`estimateTransactionFees`); the script does
   this. The script rewrites `deployments/studio-next.json` with the real vault id, tx hashes and
   readbacks.
3. Optional: `genlayer account use shiporslash-founder`, then `genlayer write <addr> withdraw_released --args 1`
   to demonstrate the pull payment.

## Deployment facts worth knowing

- Studio Next needs an explicit fee object on every write; omitting it reverts with
  `FeeValueMustBeNonZero(1)`, and so does a bare `feeValue` without a `distribution`. Two such reverted
  attempts are recorded in `deployments/studio-next.json`.
- The studio faucet (`sim_fundAccount`) credits only the EIP-55 **checksummed** address. A lowercase
  address is accepted, returns a finalized tx hash, and credits nothing.
