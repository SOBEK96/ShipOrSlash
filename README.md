# ShipOrSlash

**Milestone-bound token vesting and a code-verified treasury, as a GenLayer Intelligent Contract.**

Calendar vesting pays founders who ship nothing. ShipOrSlash escrows native GEN in a
vault and releases it in three fixed tranches (20% / 30% / 50%), each unlocked only
when two of three independent verifier mirrors corroborate a signed, CI-passing,
published SemVer release. Tranches that are not shipped by the vault deadline can be
slashed back to the funder.

> **Trust assumption: the beneficiary must inspect the verifier mirrors before accepting.**
> The *funder* chooses the repository, the signer, the package targets and the three verifier
> mirrors. A funder who picks mirrors they control could suppress every release and then slash the
> vault. The protocol's safeguard is that **a new vault is only an offer**: nothing can be claimed
> until the designated beneficiary has inspected it and called `accept_vault_terms()` within a
> **48-hour window**. If they reject it, or ignore it, the funder can cancel and recover 100% of the
> principal. Acceptance makes the registry binding on both sides. The contract cannot tell whether a
> mirror host is under the funder's control or serves immutable content; that judgement is the
> beneficiary's, and it is made once, at acceptance. See [Trust assumptions](#trust-assumptions).

## Status (read this first)

| Item | State |
|---|---|
| Contract (`contracts/ship_or_slash.py`) | `genvm-lint check` and `typecheck`: 0 errors; 15 methods (7 views, 8 writes) |
| Contract tests | **777 passed** (`pytest`); 31 of 32 targeted mutants killed across three review rounds, the one survivor being a redundant guard (see limitations) |
| Frontend | `tsc`, `eslint --max-warnings 0`, `npm run build` clean; **881 vitest passed**; `npm audit`: **0 vulnerabilities** |
| Studio Next deployment | `0x82045afB84e9B14dC262bA581b32837f640abdd0`, deploy tx `0xffd44cdb…78e9e`, `FINALIZED`; on-chain source is byte-identical to the repo file (sha256 `23642af1…`) |
| Acceptance window, live | A claim from the unaccepted vault was **refused on-chain** (`ERR_INVALID_STATE vault is PENDING_ACCEPTANCE`); the beneficiary accepted; an **early cancel was refused** (`ERR_ACCEPTANCE_WINDOW`); a rejected offer was **cancelled and the full principal reclaimed** (vault 3). The *lapse* path (window expires unanswered) was **not** exercised live (it needs 48 hours) and is covered at the exact boundary second in direct-mode tests |
| Tranche claim, live | Vault 1: tranche 1 **ACCEPTED** through a 3-of-3 quorum (`v0.1.0-alpha.1`, 0.1 GEN released, commit and artifact digest recorded) |
| Lag rule, live | Vault 2 (feeds where only mirror A carries the record, B and C return 404): `claim_milestone` → **verdict 2 QUORUM_FAILURE**, `source_count 3`, nothing released, vault still `ACTIVE`. One confirmation beside two 404s is retryable, not a rejection |
| Mock feeds | Pushed; main pin `2d32a3d…` (200 on all three hosts) and lag pin `48c9d14…` (200 / 404 / 404) |
| Native payouts (`withdraw_released`, `reclaim_unreleased`, `cancel_vault`) | **Not delivered on Studio Next, so unverified.** Each debits the vault, finalizes, and emits one correct message, but the value never arrives. A minimal probe contract shows the same for any contract (see limitations). The refund of vault 3's 0.001 GEN is in this state |

Everything in `deployments/studio-next.json` was read back from the chain. Earlier contracts
(`0x059c6759…cDc6`, `0xe5578Ae6…E271`) are superseded and unused; the second ran vaults that were
`ACTIVE` at creation and treated 404s as rejections.

## How it works

```
funder ──create_vault(value)──▶ OFFER  (PENDING_ACCEPTANCE, 48 h window)
                                  │ registry: repo, signer hash, SemVer prefix,
                                  │ npm/docker targets, 3 mirrors (all chosen by the funder)
   beneficiary ──accept_vault_terms──▶ ACTIVE   (registry now binding; T1 20% · T2 30% · T3 50%)
   beneficiary ──reject_vault_terms──▶ REJECTED ─┐
   (window lapses unanswered)                    ├─▶ funder ──cancel_vault──▶ 100% of principal back
                                                 ┘

ACTIVE:  beneficiary/funder ──claim_milestone(n)──▶ 3 mirrors fetched ──▶ 2-of-3 quorum
                                          │ VERIFIED  → tranche released
                                          │ REJECTED  → two mirrors explicitly report it invalid
                                          └ RETRYABLE → anything unproven (404, CI running,
                                                         outage, disagreement); nothing moves
         beneficiary ──withdraw_released──▶ pulls what was released
         funder ──reclaim_unreleased (after the deadline)──▶ slashes what was not shipped
```

### Invariants the contract enforces

1. **No float anywhere.** State, views, arithmetic and the clock are `int`/`str`/`bool`/`list`/`dict`.
   Shares are integer basis points; amounts are integer wei, returned as decimal strings. The block
   clock is built from `timedelta.days`/`.seconds` so `datetime.timestamp()` (a float) is never called.
   A test walks the contract's AST and fails on any float constant, `/`, or `float`.
2. **Immutable registry, accepted by the beneficiary.** `create_vault` commits the repository
   (GitHub/GitLab only), the sha256 of the signer's GPG fingerprint, the tag prefix, npm/docker
   targets and the three mirror base URLs. There is no setter (a test asserts none exists), and a
   vault stays an offer until the beneficiary calls `accept_vault_terms()`.
3. **Three hosts, three operators.** Mirrors must be https, DNS-named (no IP/localhost/internal
   suffixes, no credentials/port/query), on three distinct hostnames *and* three distinct operators
   (`raw.githubusercontent.com` and `api.github.com` are two hosts but one operator).
3a. **The beneficiary's window is protected.** The window is 48 hours (`ACCEPTANCE_WINDOW`).
   Acceptance is allowed up to and including the last second; the funder can cancel only strictly
   after it (or after a rejection), so the two are never both open. A deadline must leave the whole
   window plus one full day to ship (`MIN_DEADLINE_WINDOW`, 3 days), so accepting at the last moment
   never leaves less than a day. While the offer is pending nothing can be claimed, topped up, or
   slashed, and the funder cannot change anything.
4. **Deterministic tranches.** Entitlement after tranche *k* is `deposited * CUM_BPS[k] // 10000`; the
   last tranche is the exact remainder, so no dust is stranded. Every tranche must round to > 0.
5. **Fault-tolerant five-step `_aggregate`; rejection needs positive proof.** The verdict payload is
   exactly `{verdict, milestone_id, source_count, release_tag, verified_ts}`; the release identity
   (`commit_sha`, `artifact_digest`) travels beside it. Each mirror is `CONFIRMED`, `FAILED` (its record
   explicitly says the release is invalid: `found=false`, unsigned, wrong signer, CI failure, wrong
   artifact ...), `NOT_FOUND` (404, CI still running, package not yet published) or `OUTAGE`. The last two
   are **lag** and prove nothing:
   - fewer than 2 sources answered → `2` QUORUM_FAILURE (retryable);
   - ≥ 2 sources confirm the same `(tag, commit_sha, registry, artifact digest)` → `1` VERIFIED;
   - ≥ 2 sources **explicitly** report the release invalid → `0` REJECTED;
   - **everything else → `2` QUORUM_FAILURE**: a lone confirmation beside 404s, `1 confirmed + 404 +
     outage`, three 404s, a single explicit rejection, mirrors that disagree. A missing record is never a
     rejection. (An earlier build counted two 404s as two rejections, so `1 confirmed + 2 × 404`, which is
     exactly what honest CDN lag looks like, was labelled `REJECTED_MILESTONE`.)
   Non-2xx other than 404/410, unparsable or oversized bodies are an *outage*, never a rejection.
   `source_count` is the number of mirrors that answered (confirmed, failed or not found; outages
   excluded), so a retryable result can show `source_count 3`.
6. **No outage slashing.** A retryable or rejected attempt only increments an informational counter;
   neither changes the vault.
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
  a positive integer (any age, including the future, is accepted; a test pins that). The day-based
  constants bound the *vault deadline*: it must be at least `ACCEPTANCE_WINDOW + MIN_WINDOW` (2 + 1 = 3
  days) away. A form that signs `now + 3 days` from a page clock is late by the time consensus executes
  and lands exactly on that boundary. The console takes the later of the client's and the chain's clock
  (`eth_getBlockByNumber`) and adds a one-hour buffer (`DEADLINE_SKEW_BUFFER_S`), computed immediately
  before signing. The contract's bounds are not loosened: the minimum protects a beneficiary from a
  funder who creates a vault and slashes it before anything could ship, so slack for skew is paid by the
  caller, not taken from that window.

## Trust assumptions

1. **The beneficiary must inspect the verifier feeds during the opt-in window, before capital is
   locked in their name.** The funder picks the three mirrors. At acceptance, check that: the repository
   and signer hash are the ones you ship and sign with; the package targets are the ones you publish to;
   each mirror host and operator is one you trust and **is not run by the funder**; and each serves
   **commit-pinned, immutable** files. Open the milestone-1 file on each mirror (the console lists the
   links while a vault is pending). After you accept, the funder can slash every tranche you have not
   shipped by the deadline, and a mirror the funder controls can keep your releases from reaching
   quorum.
2. **The contract cannot verify that mirrors are independent of the funder, or that a host's content is
   immutable.** It enforces three distinct hostnames and three distinct operators by a suffix
   heuristic, not by ownership.
3. **Acceptance is the only control.** There is no on-chain dispute process and no fallback to a
   default set of trusted verifiers. Such a fallback (a governed registry of default mirrors that a
   disputed vault could revert to) was considered and **not built**: there is no existing trusted
   registry to point at, and inventing one here would be a placeholder, not a safeguard. A beneficiary
   who does not trust the funder's mirrors should reject the offer.
4. **The funder can still slash after the deadline.** That is the point of the protocol. Acceptance
   guarantees only that the beneficiary saw the terms, and has at least one full day after accepting.

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
  debit the vault (and `cancel_vault` likewise), then `emit_transfer(on="finalized")`. On Studio Next that message is recorded on the
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
- **A disagreement between mirrors is retryable forever.** Two valid confirmations that disagree on
  the tag, commit or digest are not proof of failure, so the result is `QUORUM_FAILURE`, which a
  permanent disagreement will repeat indefinitely. It costs only the caller's fee and changes nothing; the
  console flags it as a conflict.
- **The lapse path was not run live.** The 48-hour expiry cannot be waited out here. The reject → cancel
  path and the early-cancel refusal were exercised live; the boundary second (accept allowed at the
  deadline, cancel only after) is covered by direct-mode tests.
- **A late claim still wins.** If the beneficiary ships after the deadline but before the funder calls
  `reclaim_unreleased`, the claim succeeds. That is deliberate: slashing is the funder's action.
- **Third-party read of mirrors from the browser** (the radar preview) needs the mirror to allow CORS.
  The preview is not consensus and moves no funds.

## Layout

```
contracts/ship_or_slash.py        the Intelligent Contract
tests/                            pytest direct-mode suite (777 tests) + contract-generated vectors/
deployments/mock_feeds/{a,b,c}/   commit-pinned synthetic milestone records
deployments/mock_feeds_lag/a/     lag demo: the record exists on mirror A only (B and C are 404)
deployments/studio-next.json      authoritative deployment record and readbacks
deployments/ship_or_slash_abi.json  schema read from the deployed contract
deploy/deploy_ship_or_slash.ts    deploy + create offer (pass 1), claim + readbacks (pass 2)
scripts/send_write.sh             send one write from a named CLI account, keeping the tx hash
frontend/                         Next.js 16.4.1 + Tailwind 4 static console (881 tests)
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

A vault is an offer, so the live run has two passes with the beneficiary's acceptance between them:

```bash
# pass 1, as the funder: deploy, create the offer (reads the new id from the receipt), stop at PENDING_ACCEPTANCE
genlayer account use shiporslash-deployer
SHIPORSLASH_FOUNDER=0xE24e3cD8f1b7dC8fBC5718F16334b89f88bdA670 \
SHIPORSLASH_FEED_PIN=2d32a3d0968cb48960374dcceb7a0f75434e4d59 \
  genlayer deploy

# the beneficiary inspects the mirrors and accepts, from their own wallet
scripts/send_write.sh shiporslash-founder <contract> accept_vault_terms /tmp/accept.out <vault id>

# pass 2, as the funder: the vault is ACTIVE, so claim tranche 1 and read everything back
SHIPORSLASH_ADDRESS=<contract> SHIPORSLASH_VAULT_ID=<id> \
SHIPORSLASH_FOUNDER=0xE24e3cD8f1b7dC8fBC5718F16334b89f88bdA670 \
SHIPORSLASH_FEED_PIN=2d32a3d0968cb48960374dcceb7a0f75434e4d59 genlayer deploy
```

Overrides: `SHIPORSLASH_SEED_WEI` (deposit), `SHIPORSLASH_FEED_DIR=mock_feeds_lag` with
`SHIPORSLASH_FEED_PIN=48c9d145255ece91a10b79f42e50df29a68e8c10` (the lag demonstration),
`SHIPORSLASH_RECORD_PATH` (write the record elsewhere). The script requires every receipt to be decided,
executed to a return, and agreed by a majority.

## Deployment facts worth knowing

- Studio Next needs an explicit fee object on every write; omitting it reverts with
  `FeeValueMustBeNonZero(1)`, and so does a bare `feeValue` without a `distribution`.
- Studio Next simulates a write during fee estimation, so a write the contract would refuse fails at
  `genlayer estimate-fees` with only "execution failed"; the contract's own refusal text (for example
  `ERR_INVALID_STATE vault is PENDING_ACCEPTANCE`) is in the base64 `result` of the failed simulation.
- Studio Next's transaction record has no `resultName` or `statusName`: the status is a string and the
  consensus result is `result_name` / the number `result`. Receipt checks must read those (a version
  that only read `resultName` rejected every successful write). The console and the script both resolve
  each fact from the named field, then the snake_case field, then the SDK's number map, and treat a name
  that contradicts a number as malformed.
- The studio faucet (`sim_fundAccount`) credits only the EIP-55 **checksummed** address. A lowercase
  address is accepted, returns a finalized tx hash, and credits nothing.
