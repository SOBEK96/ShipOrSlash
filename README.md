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
| Contract (`contracts/ship_or_slash.py`) | `genvm-lint check` and `typecheck`: 0 errors |
| Contract tests | **679 passed** (`pytest`); 9 of 10 targeted mutants killed (the survivor is a redundant guard, see below) |
| Frontend | `tsc`, `eslint --max-warnings 0`, `npm run build` clean; **802 vitest passed**; `npm audit`: **0 vulnerabilities** |
| Studio Next deployment | `0xe5578Ae6bc82767F86EC6Ff158A113bAF224E271`, deploy tx `0x3fa8081e…ed94d`, `FINALIZED`; on-chain source is byte-identical to the repo file (sha256 `e4f10edc…`) |
| Live vault | Vault #1 seeded with **0.5 GEN** (`0x600f6a8e…573f5`) |
| Live `claim_milestone` | Tranche 1 `0xeaac6722…b92d` and tranche 2 `0x97976e60…c9bf3`, both `FINALIZED`, `MAJORITY_AGREE` (3 of 5): **tranches 1 and 2 ACCEPTED** (`v0.1.0-alpha.1`, `v0.9.0-rc.1`), 0.25 GEN released, commit and artifact digest recorded on-chain |
| Mock feeds | Pushed; pinned commit `2d32a3d0968cb48960374dcceb7a0f75434e4d59`; HTTP 200 on `raw.githubusercontent.com`, `cdn.jsdelivr.net`, `raw.githack.com` |
| Pull payment (native payout) | **Not verified, and not delivered on Studio Next.** `withdraw_released` executes, debits the vault and emits one correct message, and its transaction finalizes, but the funds never arrive. A minimal probe contract shows the same for any contract (see below). Needs a network where native payouts are delivered |

Everything in `deployments/studio-next.json` was read back from the chain. The earlier contract at
`0x059c6759…cDc6` is superseded and unused (it ran the previous validator rules).

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
5. **Fault-tolerant five-step `_aggregate`.** The verdict payload is exactly
   `{verdict, milestone_id, source_count, release_tag, verified_ts}`; the release identity
   (`commit_sha`, `artifact_digest`) travels beside it:
   - fewer than 2 sources answered → `2` QUORUM_FAILURE (retryable);
   - ≥ 2 sources confirm the same `(tag, commit_sha, registry, artifact digest)` → `1` VERIFIED;
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
milestone and verdict match and, for VERIFIED, the **release tag, the `commit_sha` and the artifact
digest** all match: the tag alone does not identify a release. It disagrees if its own view is a
retryable outage while the leader claims VERIFIED, so a lagging validator can cost liveness but never
safety.

On acceptance the contract records the tranche's tag, commit and digest on-chain. They are then part
of the vault's record: a commit or digest that earned one tranche is rejected for every later tranche,
so one build cannot be re-tagged to collect another.

**What "the registry" can and cannot pin.** A vault commits the repository, signer hash, tag prefix and
package targets at creation. The commit and artifact digest of a future release do not exist yet, so
they cannot be committed in advance; they are pinned at acceptance and enforced thereafter.

**Mirrors must attest the same artifact.** Confirmations are grouped by registry as well as digest,
because an npm tarball and a docker image legitimately have different digests. Two mirrors vouching for
different artifacts do not corroborate each other. A project that publishes to both registries must
have each mirror attest the same one.

### SemVer rules

Strict SemVer 2.0.0 without build metadata, with the vault's prefix (`""` or `v`) required exactly.
Tranche 1 needs an `-alpha`/`-beta` pre-release, tranche 2 an `-rc`, tranche 3 a stable ≥ 1.0.0.
Each tranche's version must strictly outrank the previous one by SemVer precedence, so a tag cannot be
reused.

## Frontend/contract parity (what the preview guarantees)

The verifier radar previews what the contract would decide. A preview that is more lenient than the
contract shows a false "Verified", so the rules are held in step by tests that replay **vectors
generated by running the real contract** (`tests/vectors/*.json`, kept exact by pytest):

- **Number spelling.** The contract reads mirror records with Python's `json.loads` and requires an
  integer *literal*. `1.0`, `1e0`, `10e-1`, `1.0000000000000001`, `NaN` are floats and are rejected;
  JavaScript's `JSON.parse` reads every one of them as `1`. The console uses its own parser
  (`strictJson.ts`) that keeps the distinction, and distinguishes unparseable bodies (`01`, `+1`, `1.`,
  `.1`, `0x1` → outage, retryable) from valid-JSON-wrong-type (`1.0`, `true`, `"1"` → failed).
- **Release identity.** Confirmations are grouped by `(tag, commit, registry, artifact digest)`, and a
  commit or digest that already earned an earlier tranche is rejected, exactly as on-chain.
- **Tranche amounts.** Pending amounts use the contract's own integer rule
  (`deposited * cumulative_bps // 10000`, minus what is already released for the next tranche).

## Vault ids, and the deadline's clock

- **Vault ids are sequential by design.** `create_vault` reads and advances its counter inside one
  atomic transaction, so concurrent creators cannot collide (a test creates 25 identical vaults at one
  block time and gets ids 1..25). A hash-derived id would not remove a race that does not exist, would
  introduce a (negligible but non-zero) collision case that needs its own handling, and would turn the
  id into a 256-bit value the console and views would have to carry. What *was* racy was the client:
  it picked the new vault as "the newest by count". The console now reads the id that `create_vault`
  returned from that transaction's own receipt, verifies the vault it names (creator, repository,
  deposit, beneficiary), and, if the receipt cannot be decoded, selects nothing rather than guessing.
- **There is no signature validity window.** The contract only requires a mirror's `verified_ts` to be
  a positive integer (any age, including the future, is accepted; a test pins that). The "one day" is
  `MIN_WINDOW`, the minimum length of a *vault deadline*. A form that signs `now + 1 day` from a page
  clock is late by the time consensus executes and lands exactly on that boundary. The console now
  takes the later of the client's and the chain's clock (`eth_getBlockByNumber`) and adds a one-hour
  buffer (`DEADLINE_SKEW_BUFFER_S`), computed immediately before signing. The contract's bounds are
  unchanged: the minimum protects a beneficiary from a funder who creates a vault and slashes it
  before anything could ship, so slack for skew is paid by the caller, not taken from that window.

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
- **One guard is redundant under test.** `_result_ok` checks the commit/digest *format* of a VERIFIED
  result. A malformed identity can never equal a validator's own well-formed one, so the equality check
  already rejects it and no direct-mode test can distinguish the two. It stays as defence in depth.
- **Native payouts are not delivered on Studio Next.** `withdraw_released` and `reclaim_unreleased`
  debit the vault, then `emit_transfer(on="finalized")`. On Studio Next that message is recorded on the
  finalized transaction (recipient and amount are correct) but the value never arrives: the founder's
  balance did not rise and the contract still holds the 0.25 GEN its accounting calls withdrawn. A
  throwaway contract containing nothing but `emit_transfer` behaves identically (`on="accepted"` is
  rejected outright), so this is the network, not this contract, though it is not established here whether
  that is the simulator or its configuration. Consequences: payouts are **unverified** until run on a
  network that delivers them, the contract cannot detect a non-delivery, and `solvent: true` is not
  evidence of delivery (it compares balance to accounting). The testnet value stranded this way is the
  vault's 0.25 GEN and the probe's 0.02 GEN.
- **`verified_ts` is not age-checked.** Any positive integer is accepted, including far-future values; it
  is recorded as the earliest timestamp among the agreeing mirrors and affects nothing else.
- **A late claim still wins.** If the beneficiary ships after the deadline but before the funder calls
  `reclaim_unreleased`, the claim succeeds. That is deliberate: slashing is the funder's action.
- **Third-party read of mirrors from the browser** (the radar preview) needs the mirror to allow CORS.
  The preview is not consensus and moves no funds.

## Layout

```
contracts/ship_or_slash.py        the Intelligent Contract
tests/                            pytest direct-mode suite (679 tests) + contract-generated vectors/
deployments/mock_feeds/{a,b,c}/   commit-pinned synthetic milestone records
deployments/studio-next.json      authoritative deployment record and readbacks
deployments/ship_or_slash_abi.json  schema read from the deployed contract
deploy/deploy_ship_or_slash.ts    deploy + seed + live claim + readbacks
frontend/                         Next.js 16.4.1 + Tailwind 4 static console (802 tests)
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

## Reproduce the live run

```bash
genlayer account use shiporslash-deployer
SHIPORSLASH_FOUNDER=0xE24e3cD8f1b7dC8fBC5718F16334b89f88bdA670 \
SHIPORSLASH_FEED_PIN=2d32a3d0968cb48960374dcceb7a0f75434e4d59 \
  genlayer deploy            # deploy -> seed 0.5 GEN -> claim_milestone(1) -> readbacks
# or reuse a deployed contract:
SHIPORSLASH_ADDRESS=0xe5578Ae6bc82767F86EC6Ff158A113bAF224E271 ... genlayer deploy
```

The script requires every receipt to be decided, executed to a return, and agreed by a majority, and
rewrites `deployments/studio-next.json` with the real vault id, tx hashes and readbacks.

## Deployment facts worth knowing

- Studio Next needs an explicit fee object on every write; omitting it reverts with
  `FeeValueMustBeNonZero(1)`, and so does a bare `feeValue` without a `distribution`. Two such reverted
  attempts are recorded in `deployments/studio-next.json`.
- Studio Next's transaction record has no `resultName` or `statusName`: the status is a string and the
  consensus result is `result_name` / the number `result`. Receipt checks must read those (a version
  that only read `resultName` rejected every successful write). The console and the script both resolve
  each fact from the named field, then the snake_case field, then the SDK's number map, and treat a name
  that contradicts a number as malformed.
- The studio faucet (`sim_fundAccount`) credits only the EIP-55 **checksummed** address. A lowercase
  address is accepted, returns a finalized tx hash, and credits nothing.
