"""Shared helpers for ShipOrSlash direct-mode tests.

Pure-ASCII. Uses the genlayer-test pytest plugin fixtures: direct_vm,
direct_deploy, direct_alice (funder), direct_bob (beneficiary) and
direct_charlie (outsider).

Direct mode runs the leader function and exposes the captured validator via
``direct_vm.run_validator``; full multi-validator consensus is exercised live by
deploy/deploy_ship_or_slash.ts.
"""

import hashlib
import json
import os
import re
import time
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

# The runner this contract pins (py-genlayer:5jycge...) ships in the v0.6.0-rc3
# .. rc8 trees; rc9 replaced it. Without this pin the harness resolves the
# newest cached tree and cannot find the runner.
os.environ.setdefault("GENVM_VERSION", "v0.6.0-rc8")

CONTRACT = "contracts/ship_or_slash.py"

ATTO = 10**18
DEPOSIT = ATTO // 2  # the 0.5 GEN the live deployment seeds
DAY = 86400

REPO = "https://github.com/SOBEK96/ShipOrSlash"
REPO_NORM = "https://github.com/sobek96/shiporslash"
FINGERPRINT = "3AA5 C34371567BD2 5FA4E14A9D8C1B7E00F26A41"
SIGNER_HASH = hashlib.sha256(FINGERPRINT.replace(" ", "").upper().encode()).hexdigest()
OTHER_SIGNER_HASH = hashlib.sha256(b"SOMEONE ELSE").hexdigest()
PIN = "0123456789abcdef0123456789abcdef01234567"  # a stand-in commit pin

BASES = {
    "A": f"https://raw.githubusercontent.com/SOBEK96/ShipOrSlash/{PIN}/deployments/mock_feeds/a/",
    "B": f"https://cdn.jsdelivr.net/gh/SOBEK96/ShipOrSlash@{PIN}/deployments/mock_feeds/b/",
    "C": f"https://raw.githack.com/SOBEK96/ShipOrSlash/{PIN}/deployments/mock_feeds/c/",
}
SLOTS = ("A", "B", "C")

TAGS = {1: "v0.1.0-alpha.1", 2: "v0.9.0-rc.1", 3: "v1.0.0"}
COMMITS = {1: "1" * 40, 2: "2" * 40, 3: "3" * 40}
NPM = "@sobek96/shiporslash"
DOCKER = "sobek96/shiporslash"
BPS = {1: 2000, 2: 3000, 3: 5000}
CUM = {0: 0, 1: 2000, 2: 5000, 3: 10000}

VERDICT_REJECTED, VERDICT_VERIFIED, VERDICT_QF = 0, 1, 2


def feed_url(slot: str, milestone: int) -> str:
    return f"{BASES[slot]}milestone_{milestone}.json"


def record(milestone: int, **over) -> dict:
    """A fully valid mirror record for `milestone`. Keyword overrides replace
    top-level fields; pass key=None to delete a field."""
    tag = TAGS[milestone]
    rec = {
        "schema": "shiporslash/v1",
        "repo_url": REPO,
        "milestone_id": milestone,
        "found": True,
        "release_tag": tag,
        "commit_sha": COMMITS[milestone],
        "signature_verified": True,
        "signer_fingerprint_sha256": SIGNER_HASH,
        "ci_status": "success",
        "artifact": {
            "registry": "npm",
            "name": NPM,
            "version": tag[1:],
            "published": True,
            "digest": "sha256:" + hashlib.sha256(tag.encode()).hexdigest(),
        },
        "verified_ts": 1760000000 + milestone,
    }
    for k, v in over.items():
        if v is None:
            rec.pop(k, None)
        else:
            rec[k] = v
    return rec


def _resp(state, milestone: int):
    """Translate a per-source state spec into a mock response, or None for 'no
    mock registered' (the harness raises, which the contract reads as OUTAGE)."""
    if isinstance(state, dict):
        return {"status": 200, "body": json.dumps(state)}
    if state == "ok":
        return {"status": 200, "body": json.dumps(record(milestone))}
    if state == "ok_docker":
        art = record(milestone)["artifact"]
        art.update(registry="docker", name=DOCKER, version=TAGS[milestone][1:])
        return {"status": 200, "body": json.dumps(record(milestone, artifact=art))}
    if state == "404":
        return {"status": 404, "body": "not found"}
    if state == "410":
        return {"status": 410, "body": "gone"}
    if state in ("503", "500", "502", "504", "429", "403", "401", "408", "301", "302"):
        return {"status": int(state), "body": "x"}
    if state == "missing":  # explicit "tag not found" record
        return {"status": 200, "body": json.dumps(record(milestone, found=False))}
    if state == "garbage":
        return {"status": 200, "body": "<html>not json</html>"}
    if state == "none":
        return None
    raise ValueError(state)


def mock_feeds(direct_vm, milestone: int, states=("ok", "ok", "ok")):
    """Re-register the three mirror mocks. First match wins in the harness, so
    this clears first."""
    direct_vm.clear_mocks()
    for slot, state in zip(SLOTS, states):
        resp = _resp(state, milestone)
        if resp is not None:
            direct_vm.mock_web("^" + re.escape(feed_url(slot, milestone)) + "$", resp)


def future(days: int = 30) -> int:
    return int(time.time()) + days * DAY


def warp_to(direct_vm, unix_ts: int) -> None:
    direct_vm.warp(datetime.fromtimestamp(unix_ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))


def fund(direct_vm, who, amount=10 * ATTO):
    try:
        direct_vm.deal(who, amount)
    except Exception:
        pass


def hexaddr(contract, direct_vm, who) -> str:
    prev = getattr(direct_vm, "sender", None)
    direct_vm.sender = who
    h = contract.whoami()
    if prev is not None:
        direct_vm.sender = prev
    return h


def create(c, vm, funder, beneficiary, value=DEPOSIT, **kw):
    """Create a vault as `funder`; returns the vault id."""
    args = dict(
        beneficiary_hex=hexaddr(c, vm, beneficiary),
        repo_url=REPO,
        signer_fp_hash=SIGNER_HASH,
        tag_prefix="v",
        npm_package=NPM,
        docker_image=DOCKER,
        feed_a=BASES["A"],
        feed_b=BASES["B"],
        feed_c=BASES["C"],
        deadline=future(30),
    )
    args.update(kw)
    fund(vm, funder)
    vm.sender = funder
    vm.value = value
    try:
        return c.create_vault(**args)
    finally:
        vm.value = 0


def claim(c, vm, who, vault_id, milestone, states=("ok", "ok", "ok")):
    mock_feeds(vm, milestone, states)
    vm.sender = who
    vm.value = 0
    return c.claim_milestone(vault_id, milestone)


def ship_all(c, vm, who, vault_id, upto=3):
    out = []
    for m in range(1, upto + 1):
        out.append(claim(c, vm, who, vault_id, m))
    return out


def quorum_oracle(states: tuple) -> int:
    """Independent restatement of the 2-of-3 verdict for the spec's source
    states, used to cross-check the contract over the whole 4^3 state space.

    states: each one of "C" (confirmed, all agreeing), "F" (failed/missing
    record), "N" (404), "O" (outage)."""
    c = states.count("C")
    f = states.count("F") + states.count("N")
    o = states.count("O")
    responded = c + f
    if responded < 2:
        return VERDICT_QF
    if c >= 2:
        return VERDICT_VERIFIED
    if f >= 2:
        return VERDICT_REJECTED
    # exactly: c == 1, f == 1, o == 1 (the only mixed case with a pending vote)
    if o >= 1 and (c + o >= 2 or f + o >= 2):
        return VERDICT_QF
    return VERDICT_REJECTED


def credit_contract(vm, amount: int) -> None:
    """Direct mode does not auto-credit self.balance on payable calls (on-chain
    it does). Mirror the chain so balance-based views are meaningful."""
    vm.deal(vm._contract_address, amount)


@pytest.fixture
def world(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    """alice = funder, bob = beneficiary, charlie = outsider."""
    c = direct_deploy(CONTRACT)
    return SimpleNamespace(
        c=c, vm=direct_vm, alice=direct_alice, bob=direct_bob, charlie=direct_charlie
    )
