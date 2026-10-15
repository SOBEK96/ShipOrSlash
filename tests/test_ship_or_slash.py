"""ShipOrSlash direct-mode suite: unit, boundary and adversarial tests.

Run: .venv/bin/python -m pytest tests -q
Pure-ASCII. Every expectation about the quorum is cross-checked against the
independent oracle in conftest, not against the contract's own helpers.
"""

import itertools
import json

import pytest

from conftest import (
    ATTO, BASES, COMMITS, CUM, DAY, DEPOSIT, DIGEST_1, DIGEST_2, DIGEST_3, DIGESTS, DOCKER, NPM,
    REPO, REPO_NORM, SIGNER_HASH,
    OTHER_SIGNER_HASH, SLOTS, TAGS, VERDICT_QF, VERDICT_REJECTED, VERDICT_VERIFIED,
    claim, create, credit_contract, feed_url, fund, future, hexaddr, mock_feeds,
    quorum_oracle, record, ship_all, warp_to,
)

MIN_DEPOSIT = ATTO // 1000
STATE_OF = {"C": "ok", "F": "missing", "N": "404", "O": "503"}


def vault(w, **kw):
    return create(w.c, w.vm, w.alice, w.bob, **kw)


def vault_at(w, done, **kw):
    """A fresh vault with the first `done` tranches already accepted."""
    vid = vault(w, **kw)
    for m in range(1, done + 1):
        r = claim(w.c, w.vm, w.bob, vid, m)
        assert r["accepted"] is True
    return vid


def revert(w, msg):
    return w.vm.expect_revert(msg)


def tag_record(m, tag, prefix="v", **over):
    """A record for milestone m carrying an arbitrary release tag."""
    art = record(m)["artifact"]
    art["version"] = tag[len(prefix):] if prefix and tag.startswith(prefix) else tag
    return record(m, release_tag=tag, artifact=art, **over)


def claim_tag(w, vid, m, tag, prefix="v"):
    rec = tag_record(m, tag, prefix)
    return claim(w.c, w.vm, w.bob, vid, m, states=(rec, rec, rec))


def walk(o):
    """Yield every scalar in a nested view result."""
    if isinstance(o, dict):
        for k, v in o.items():
            assert isinstance(k, str)
            yield from walk(v)
    elif isinstance(o, (list, tuple)):
        for v in o:
            yield from walk(v)
    else:
        yield o


def invariants(c):
    """Cross-vault accounting identities that must hold after every call."""
    ps = c.get_protocol_state()
    escrow = 0
    released_sum = 0
    for vid in range(1, ps["vault_count"] + 1):
        v = c.get_vault_state(vid)
        dep, rel = int(v["deposited"]), int(v["released"])
        wd, rc = int(v["withdrawn"]), int(v["reclaimed"])
        assert 0 <= wd <= rel <= dep
        assert rel + rc <= dep
        assert int(v["unreleased"]) == dep - rel - rc
        assert int(v["withdrawable"]) == rel - wd
        done = v["tranches_done"]
        assert rel == sum(int(t["amount"]) for t in v["tranches"][:done])
        if done:
            # Released was priced at the deposit that stood when the last tranche
            # was accepted; a later top-up only raises the ceiling.
            assert rel <= dep * CUM[done] // 10000
        if v["status"] == "COMPLETE":
            assert done == 3 and rel == dep
        escrow += dep - wd - rc
        released_sum += rel
    assert int(ps["total_escrow"]) == escrow
    assert int(ps["total_released"]) == released_sum
    return ps


# ============================================================ deployment ====
def test_deploy_initial_state(world):
    ps = world.c.get_protocol_state()
    assert ps["vault_count"] == 0 and ps["next_vault_id"] == 1
    assert ps["total_escrow"] == "0" and ps["total_released"] == "0"
    assert ps["total_slashed"] == "0"


def test_constants_view(world):
    k = world.c.get_constants()
    assert k["tranche_bps"] == [2000, 3000, 5000]
    assert k["cumulative_bps"] == [2000, 5000, 10000]
    assert sum(k["tranche_bps"]) == k["bps_denominator"] == 10000
    assert k["tranche_kinds"] == ["ALPHA", "RC", "STABLE"]
    assert k["quorum"] == 2 and k["sources"] == 3
    assert k["min_deposit"] == str(MIN_DEPOSIT)


def test_whoami_is_sender(world):
    world.vm.sender = world.alice
    a = world.c.whoami()
    world.vm.sender = world.bob
    b = world.c.whoami()
    assert a != b and a.startswith("0x") and len(a) == 42


# ====================================================== vault creation =====
def test_create_vault_returns_sequential_ids(world):
    assert vault(world) == 1
    assert vault(world) == 2
    assert vault(world) == 3
    assert world.c.get_protocol_state()["vault_count"] == 3


def test_create_vault_commits_registry(world):
    vid = vault(world)
    v = world.c.get_vault_state(vid)
    assert v["status"] == "ACTIVE"
    assert v["repo_url"] == REPO_NORM
    assert v["signer_hash"] == SIGNER_HASH
    assert v["tag_prefix"] == "v"
    assert v["npm_package"] == NPM and v["docker_image"] == DOCKER
    assert v["feeds"] == [BASES["A"], BASES["B"], BASES["C"]]
    assert v["funder"] == hexaddr(world.c, world.vm, world.alice)
    assert v["beneficiary"] == hexaddr(world.c, world.vm, world.bob)
    assert v["deposited"] == str(DEPOSIT)
    assert v["unreleased"] == str(DEPOSIT)
    assert v["tranches_done"] == 0 and v["attempts"] == 0


def test_create_vault_tracks_escrow(world):
    vault(world)
    vault(world, value=2 * DEPOSIT)
    ps = invariants(world.c)
    assert ps["total_escrow"] == str(3 * DEPOSIT)


def test_registry_has_no_setters(world):
    """Immutability by construction: the ABI exposes no mutator for the registry."""
    names = {n for n in dir(world.c) if not n.startswith("_")}
    for banned in ("set_repo", "update_registry", "set_signer", "set_feeds", "set_beneficiary",
                   "update_vault", "change_repo", "set_feed_a", "rotate_signer"):
        assert banned not in names


@pytest.mark.parametrize("url,expected", [
    ("https://github.com/SOBEK96/ShipOrSlash", "https://github.com/sobek96/shiporslash"),
    ("https://github.com/SOBEK96/ShipOrSlash.git", "https://github.com/sobek96/shiporslash"),
    ("https://github.com/SOBEK96/ShipOrSlash/", "https://github.com/sobek96/shiporslash"),
    ("https://gitlab.com/group/proj", "https://gitlab.com/group/proj"),
    ("HTTPS://GITHUB.COM/Owner/Repo", "https://github.com/owner/repo"),
    ("https://github.com/a/b.c_d-e", "https://github.com/a/b.c_d-e"),
])
def test_repo_url_normalization(world, url, expected):
    vid = vault(world, repo_url=url)
    assert world.c.get_vault_state(vid)["repo_url"] == expected


@pytest.mark.parametrize("url", [
    "http://github.com/a/b", "https://github.com/a", "https://github.com/a/b/c",
    "https://bitbucket.org/a/b", "https://github.com.evil.com/a/b",
    "https://github.com:8080/a/b", "https://user@github.com/a/b",
    "https://github.com/a/b?x=1", "https://github.com/a/b#x", "https://github.com/../b",
    "https://github.com/a/b c", "", "github.com/a/b", "https://github.com//b",
    "https://github.com/a/..", "ftp://github.com/a/b", "https://github.com/a\\b",
    "https://github.com/" + "a" * 400 + "/b", "https://github.com/a/b%20c",
])
def test_repo_url_rejected(world, url):
    with revert(world, "ERR_INVALID_REGISTRY"):
        vault(world, repo_url=url)


@pytest.mark.parametrize("h", [
    SIGNER_HASH, SIGNER_HASH.upper(), "0x" + SIGNER_HASH, "  " + SIGNER_HASH + "  ",
])
def test_signer_hash_normalized(world, h):
    vid = vault(world, signer_fp_hash=h)
    assert world.c.get_vault_state(vid)["signer_hash"] == SIGNER_HASH


@pytest.mark.parametrize("h", [
    "", "0x", SIGNER_HASH[:-1], SIGNER_HASH + "0", "g" * 64, "z" + SIGNER_HASH[1:],
    "3AA5C34371567BD25FA4E14A9D8C1B7E00F26A41",  # a raw 40-hex fingerprint, not a digest
])
def test_signer_hash_rejected(world, h):
    with revert(world, "ERR_INVALID_REGISTRY"):
        vault(world, signer_fp_hash=h)


@pytest.mark.parametrize("prefix", ["V", "vv", "ver", " ", "release-", "x"])
def test_tag_prefix_rejected(world, prefix):
    with revert(world, "ERR_INVALID_REGISTRY"):
        vault(world, tag_prefix=prefix)


@pytest.mark.parametrize("prefix", ["", "v"])
def test_tag_prefix_accepted(world, prefix):
    assert vault(world, tag_prefix=prefix) == 1


def test_artifact_target_required(world):
    with revert(world, "ERR_INVALID_REGISTRY"):
        vault(world, npm_package="", docker_image="")


@pytest.mark.parametrize("kw", [
    {"npm_package": "", "docker_image": DOCKER},
    {"npm_package": NPM, "docker_image": ""},
])
def test_single_artifact_target_accepted(world, kw):
    assert vault(world, **kw) == 1


@pytest.mark.parametrize("name", ['bad name', 'a"b', "a\\b", "<x>", "x" * 101, "café"])
def test_artifact_target_rejected(world, name):
    with revert(world, "ERR_INVALID_REGISTRY"):
        vault(world, npm_package=name)


# ====================================================== verifier feeds =====
@pytest.mark.parametrize("bad", [
    "http://raw.githubusercontent.com/x/", "https://127.0.0.1/x/", "https://localhost/x/",
    "https://10.0.0.5/x/", "https://[::1]/x/", "https://user:pw@raw.githubusercontent.com/x/",
    "https://raw.githubusercontent.com:8443/x/", "https://raw.githubusercontent.com/x/?a=1",
    "https://raw.githubusercontent.com/x/#f", "https://raw.githubusercontent.com/x",
    "ftp://raw.githubusercontent.com/x/", "", "https://metadata.internal/x/",
    "https://printer.local/x/", "https://evil.com\\@raw.githubusercontent.com/x/",
    "https://exa mple.com/x/", "https://-bad-.com/x/", "https://2130706433/x/",
    "https://a..b.com/x/", "https://" + "a" * 400 + ".com/x/",
    "https://exaämple.com/x/", "https://169.254.169.254/latest/", "https://192.168.1.1/x/",
])
def test_unsafe_feed_rejected(world, bad):
    with revert(world, "ERR_INVALID_VERIFIER_FEEDS"):
        vault(world, feed_a=bad)


@pytest.mark.parametrize("slot", ["feed_a", "feed_b", "feed_c"])
def test_unsafe_feed_rejected_in_every_slot(world, slot):
    with revert(world, "ERR_INVALID_VERIFIER_FEEDS"):
        vault(world, **{slot: "https://127.0.0.1/x/"})


def test_duplicate_host_rejected(world):
    with revert(world, "ERR_INVALID_VERIFIER_FEEDS"):
        vault(world, feed_b=BASES["A"])


@pytest.mark.parametrize("a,b", [
    ("https://raw.githubusercontent.com/o/r/", "https://api.github.com/repos/o/r/"),
    ("https://cdn.jsdelivr.net/gh/o/r/", "https://fastly.jsdelivr.net/gh/o/r/"),
    ("https://a.example.org/p/", "https://b.example.org/p/"),
    ("https://github.com/o/r/", "https://o.github.io/r/"),
    ("https://gitlab.com/o/r/", "https://o.gitlab.io/r/"),
    ("https://registry.npmjs.org/p/", "https://www.npmjs.com/p/"),
])
def test_same_operator_distinct_hosts_rejected(world, a, b):
    """Different hostnames are not independence: the operator must differ too."""
    with revert(world, "ERR_INVALID_VERIFIER_FEEDS"):
        vault(world, feed_a=a, feed_b=b, feed_c="https://zzz.example.io/p/")


def test_three_custom_operators_accepted(world):
    vid = vault(world, feed_a="https://a.example.org/p/", feed_b="https://b.example.net/p/",
                feed_c="https://c.example.io/p/")
    src = world.c.get_verifier_sources(vid)
    assert src["independent"] is True
    assert src["distinct_hosts"] == 3 and src["distinct_operators"] == 3


def test_uppercase_feed_host_is_lowercased(world):
    vid = vault(world, feed_a="https://RAW.GITHUBUSERCONTENT.COM/o/r/")
    assert world.c.get_verifier_sources(vid)["sources"][0]["host"] == "raw.githubusercontent.com"


def test_verifier_sources_view(world):
    vid = vault(world)
    s = world.c.get_verifier_sources(vid)
    assert [r["slot"] for r in s["sources"]] == ["A", "B", "C"]
    assert [r["host"] for r in s["sources"]] == [
        "raw.githubusercontent.com", "cdn.jsdelivr.net", "raw.githack.com"]
    assert [r["operator"] for r in s["sources"]] == ["github", "jsdelivr", "githack"]
    assert s["independent"] is True and s["quorum"] == 2
    assert s["repo_url"] == REPO_NORM and s["signer_hash"] == SIGNER_HASH


# =========================================== beneficiary / deposit / time ==
def test_beneficiary_must_differ_from_funder(world):
    fund(world.vm, world.alice)
    world.vm.sender = world.alice
    world.vm.value = DEPOSIT
    with revert(world, "ERR_INVALID_PARAMS"):
        world.c.create_vault(hexaddr(world.c, world.vm, world.alice), REPO, SIGNER_HASH, "v",
                             NPM, DOCKER, BASES["A"], BASES["B"], BASES["C"], future(30))


@pytest.mark.parametrize("bad", [
    "0x0000000000000000000000000000000000000000", "0x123", "", "not-an-address",
    "0x" + "g" * 40,
])
def test_beneficiary_invalid_rejected(world, bad):
    with revert(world, "ERR_INVALID_PARAMS"):
        vault(world, beneficiary_hex=bad)


@pytest.mark.parametrize("value", [0, 1, MIN_DEPOSIT - 1])
def test_deposit_below_floor_rejected(world, value):
    with revert(world, "ERR_DEPOSIT_BELOW_FLOOR"):
        vault(world, value=value)


def test_deposit_at_floor_accepted(world):
    vid = vault(world, value=MIN_DEPOSIT)
    v = world.c.get_vault_state(vid)
    assert all(int(t["amount"]) > 0 for t in v["tranches"])
    assert sum(int(t["amount"]) for t in v["tranches"]) == MIN_DEPOSIT


@pytest.mark.parametrize("dep", [
    MIN_DEPOSIT, MIN_DEPOSIT + 1, MIN_DEPOSIT + 3, 123456789012345678, ATTO,
    7 * 10**17 + 1, 999999999999999999, 3 * ATTO + 7, 10**21 + 13, 2**64 + 1,
])
def test_tranche_arithmetic_has_zero_drift(world, dep):
    vid = vault(world, value=dep)
    r = ship_all(world.c, world.vm, world.bob, vid)
    amounts = [int(x["released"]) for x in r]
    assert amounts[0] == dep * 2000 // 10000
    assert amounts[0] + amounts[1] == dep * 5000 // 10000
    assert sum(amounts) == dep  # the final tranche absorbs every rounding remainder
    assert amounts[2] >= dep // 2
    v = world.c.get_vault_state(vid)
    assert v["status"] == "COMPLETE" and v["unreleased"] == "0"
    invariants(world.c)


@pytest.mark.parametrize("offset,ok", [
    (-DAY, False), (0, False), (DAY - 5000, False), (DAY + 5000, True),
    (30 * DAY, True), (5 * 365 * DAY - 5000, True), (5 * 365 * DAY + 5000, False),
])
def test_deadline_window(world, offset, ok):
    import time
    dl = int(time.time()) + offset
    if ok:
        assert vault(world, deadline=dl) == 1
    else:
        with revert(world, "ERR_INVALID_PARAMS"):
            vault(world, deadline=dl)


# ====================================================== top-up =============
def top_up(w, who, vid, value):
    fund(w.vm, who)
    w.vm.sender = who
    w.vm.value = value
    try:
        return w.c.top_up_vault(vid)
    finally:
        w.vm.value = 0


def test_top_up_increases_deposit(world):
    vid = vault(world)
    top_up(world, world.alice, vid, DEPOSIT)
    v = world.c.get_vault_state(vid)
    assert v["deposited"] == str(2 * DEPOSIT)
    assert invariants(world.c)["total_escrow"] == str(2 * DEPOSIT)


def test_top_up_only_funder(world):
    vid = vault(world)
    for who in (world.bob, world.charlie):
        with revert(world, "ERR_UNAUTHORIZED"):
            top_up(world, who, vid, DEPOSIT)


def test_top_up_below_floor(world):
    vid = vault(world)
    with revert(world, "ERR_DEPOSIT_BELOW_FLOOR"):
        top_up(world, world.alice, vid, MIN_DEPOSIT - 1)


def test_top_up_unknown_vault(world):
    with revert(world, "ERR_INVALID_STATE"):
        top_up(world, world.alice, 99, DEPOSIT)


def test_top_up_between_tranches_reprices_only_the_future(world):
    vid = vault(world)
    r1 = claim(world.c, world.vm, world.bob, vid, 1)
    assert int(r1["released"]) == DEPOSIT * 2000 // 10000
    top_up(world, world.alice, vid, DEPOSIT)
    total = 2 * DEPOSIT
    r2 = claim(world.c, world.vm, world.bob, vid, 2)
    assert int(world.c.get_vault_state(vid)["released"]) == total * 5000 // 10000
    assert int(r2["released"]) == total * 5000 // 10000 - DEPOSIT * 2000 // 10000
    r3 = claim(world.c, world.vm, world.bob, vid, 3)
    assert world.c.get_vault_state(vid)["released"] == str(total)
    assert int(r3["released"]) == total - total * 5000 // 10000
    invariants(world.c)


@pytest.mark.parametrize("terminal", ["COMPLETE", "SLASHED"])
def test_top_up_closed_vault_rejected(world, terminal):
    if terminal == "COMPLETE":
        vid = vault_at(world, 3)
    else:
        vid = vault(world, deadline=future(2))
        warp_to(world.vm, future(3))
        world.vm.sender = world.alice
        world.c.reclaim_unreleased(vid)
    with revert(world, "ERR_INVALID_STATE"):
        top_up(world, world.alice, vid, DEPOSIT)


# ============================================ quorum: the whole 4^3 space ==
@pytest.mark.parametrize("combo", list(itertools.product("CFNO", repeat=3)),
                         ids=lambda c: "".join(c))
def test_quorum_matrix(world, combo):
    vid = vault(world)
    states = tuple(STATE_OF[x] for x in combo)
    r = claim(world.c, world.vm, world.bob, vid, 1, states)
    want = quorum_oracle(combo)
    assert r["verdict"] == want
    assert r["milestone_id"] == 1
    assert r["source_count"] == 3 - combo.count("O")
    v = world.c.get_vault_state(vid)
    if want == VERDICT_VERIFIED:
        assert r["accepted"] is True and r["release_tag"] == TAGS[1]
        assert r["verified_ts"] > 0
        assert v["tranches_done"] == 1 and v["released"] == str(DEPOSIT * 2000 // 10000)
    else:
        assert r["accepted"] is False and r["release_tag"] == "" and r["verified_ts"] == 0
        assert r["released"] == "0"
        assert v["tranches_done"] == 0 and v["released"] == "0"
    assert v["last_verdict"] == want and v["attempts"] == 1


@pytest.mark.parametrize("combo", [c for c in itertools.product("CFNO", repeat=3) if "O" in c],
                         ids=lambda c: "".join(c))
def test_quorum_matrix_unmocked_outage(world, combo):
    """An unreachable mirror (no response at all) behaves exactly like a 503."""
    vid = vault(world)
    states = tuple("none" if x == "O" else STATE_OF[x] for x in combo)
    r = claim(world.c, world.vm, world.bob, vid, 1, states)
    assert r["verdict"] == quorum_oracle(combo)


@pytest.mark.parametrize("status", ["500", "502", "503", "504", "429", "403", "401", "408", "301", "302"])
def test_every_non_2xx_non_404_is_outage_not_rejection(world, status):
    """The spec's headline case: 1 CONFIRMED + 1 404 (lag) + 1 OUTAGE is retryable."""
    vid = vault(world)
    r = claim(world.c, world.vm, world.bob, vid, 1, ("ok", "404", status))
    assert r["verdict"] == VERDICT_QF and r["source_count"] == 2


@pytest.mark.parametrize("code", ["404", "410"])
def test_404_and_410_are_missing(world, code):
    vid = vault(world)
    r = claim(world.c, world.vm, world.bob, vid, 1, (code, code, "ok"))
    assert r["verdict"] == VERDICT_REJECTED


def test_garbage_body_is_outage_not_rejection(world):
    vid = vault(world)
    r = claim(world.c, world.vm, world.bob, vid, 1, ("ok", "garbage", "garbage"))
    assert r["verdict"] == VERDICT_QF  # one witness only: retryable, never a rejection


def test_two_garbage_and_one_confirmed_is_retryable(world):
    vid = vault(world)
    r = claim(world.c, world.vm, world.bob, vid, 1, ("garbage", "ok", "garbage"))
    assert r["verdict"] == VERDICT_QF and r["source_count"] == 1


def test_oversized_body_is_outage(world):
    vid = vault(world)
    big = dict(record(1), padding="x" * 40000)
    r = claim(world.c, world.vm, world.bob, vid, 1, (big, big, "ok"))
    assert r["verdict"] == VERDICT_QF and r["source_count"] == 1


@pytest.mark.parametrize("body", ["[]", "42", '"s"', "null", "true"])
def test_non_object_json_is_outage(world, body):
    vid = vault(world)
    mock_feeds(world.vm, 1, ("ok", "ok", "ok"))
    world.vm.clear_mocks()
    for slot in SLOTS:
        payload = body if slot == "C" else json.dumps(record(1))
        world.vm.mock_web("^" + __import__("re").escape(feed_url(slot, 1)) + "$",
                          {"status": 200, "body": payload})
    world.vm.sender = world.bob
    r = world.c.claim_milestone(vid, 1)
    assert r["verdict"] == VERDICT_VERIFIED and r["source_count"] == 2


def test_docker_artifact_target_is_accepted(world):
    vid = vault(world)
    r = claim(world.c, world.vm, world.bob, vid, 1, ("ok_docker", "ok", "ok_docker"))
    assert r["verdict"] == VERDICT_VERIFIED


def test_mirrors_attesting_different_registries_do_not_corroborate(world):
    """An npm tarball digest and a docker image digest are different artifacts;
    two mirrors that each vouch for a different one have not agreed."""
    vid = vault(world)
    r = claim(world.c, world.vm, world.bob, vid, 1, ("ok", "ok_docker", "503"))
    assert r["verdict"] == VERDICT_QF  # no group of two, and the silent mirror could break the tie
    r = claim(world.c, world.vm, world.bob, vid, 1, ("ok", "ok_docker", "404"))
    assert r["verdict"] == VERDICT_REJECTED and r["released"] == "0"


def test_two_of_three_on_one_registry_still_verifies_beside_a_dissenter(world):
    vid = vault(world)
    r = claim(world.c, world.vm, world.bob, vid, 1, ("ok", "ok_docker", "ok"))
    assert r["verdict"] == VERDICT_VERIFIED and r["source_count"] == 3


# --- conflicting confirmations ---------------------------------------------
def conflict(m, **over):
    return record(m, release_tag="v0.1.0-alpha.2", commit_sha="9" * 40,
                  artifact=dict(record(m)["artifact"], version="0.1.0-alpha.2"), **over)


def test_two_confirmed_but_conflicting_is_rejected(world):
    vid = vault(world)
    r = claim(world.c, world.vm, world.bob, vid, 1, ("ok", conflict(1), "404"))
    assert r["verdict"] == VERDICT_REJECTED


def test_two_conflicting_plus_outage_is_retryable(world):
    vid = vault(world)
    r = claim(world.c, world.vm, world.bob, vid, 1, ("ok", conflict(1), "503"))
    assert r["verdict"] == VERDICT_QF


def test_three_way_conflict_is_rejected(world):
    vid = vault(world)
    third = record(1, release_tag="v0.1.0-alpha.3", commit_sha="8" * 40,
                   artifact=dict(record(1)["artifact"], version="0.1.0-alpha.3"))
    r = claim(world.c, world.vm, world.bob, vid, 1, ("ok", conflict(1), third))
    assert r["verdict"] == VERDICT_REJECTED


def test_same_tag_different_commit_does_not_corroborate(world):
    """A mirror claiming the tag points at a different commit is a disagreement."""
    vid = vault(world)
    other = record(1, commit_sha="f" * 40)
    r = claim(world.c, world.vm, world.bob, vid, 1, ("ok", other, "404"))
    assert r["verdict"] == VERDICT_REJECTED


def test_majority_beats_one_dissenter(world):
    vid = vault(world)
    r = claim(world.c, world.vm, world.bob, vid, 1, ("ok", "ok", conflict(1)))
    assert r["verdict"] == VERDICT_VERIFIED and r["release_tag"] == TAGS[1]


def test_verified_ts_is_the_minimum_of_the_agreeing_group(world):
    vid = vault(world)
    a, b = record(1, verified_ts=1760000500), record(1, verified_ts=1760000200)
    r = claim(world.c, world.vm, world.bob, vid, 1, (a, b, "503"))
    assert r["verdict"] == VERDICT_VERIFIED and r["verified_ts"] == 1760000200


def test_verified_ts_ignores_the_dissenter(world):
    vid = vault(world)
    a, b = record(1, verified_ts=1760000500), record(1, verified_ts=1760000400)
    c = conflict(1, verified_ts=1)
    r = claim(world.c, world.vm, world.bob, vid, 1, (a, c, b))
    assert r["verified_ts"] == 1760000400


# =================================== per-source tampering (field level) ====
def _art(m, **o):
    a = record(m)["artifact"]
    a.update(o)
    return a


TAMPER = {
    "wrong_schema": lambda m: record(m, schema="other/v9"),
    "missing_schema": lambda m: record(m, schema=None),
    "wrong_repo": lambda m: record(m, repo_url="https://github.com/evil/fork"),
    "repo_not_a_url": lambda m: record(m, repo_url="nonsense"),
    "repo_missing": lambda m: record(m, repo_url=None),
    "wrong_milestone": lambda m: record(m, milestone_id=m + 3),
    "milestone_float": lambda m: record(m, milestone_id=float(m)),
    "milestone_bool": lambda m: record(m, milestone_id=True),
    "milestone_string": lambda m: record(m, milestone_id=str(m)),
    "found_false": lambda m: record(m, found=False),
    "found_string": lambda m: record(m, found="true"),
    "found_missing": lambda m: record(m, found=None),
    "tag_missing": lambda m: record(m, release_tag=None),
    "tag_not_semver": lambda m: record(m, release_tag="v1.0"),
    "tag_not_string": lambda m: record(m, release_tag=7),
    "bad_commit": lambda m: record(m, commit_sha="xyz"),
    "short_commit": lambda m: record(m, commit_sha="a" * 39),
    "upper_commit": lambda m: record(m, commit_sha="A" * 40),
    "missing_commit": lambda m: record(m, commit_sha=None),
    "unsigned": lambda m: record(m, signature_verified=False),
    "signed_as_string": lambda m: record(m, signature_verified="true"),
    "signed_missing": lambda m: record(m, signature_verified=None),
    "wrong_signer": lambda m: record(m, signer_fingerprint_sha256=OTHER_SIGNER_HASH),
    "signer_malformed": lambda m: record(m, signer_fingerprint_sha256="abc"),
    "signer_missing": lambda m: record(m, signer_fingerprint_sha256=None),
    "ts_zero": lambda m: record(m, verified_ts=0),
    "ts_negative": lambda m: record(m, verified_ts=-5),
    "ts_float": lambda m: record(m, verified_ts=1760000000.5),
    "ts_bool": lambda m: record(m, verified_ts=True),
    "ts_missing": lambda m: record(m, verified_ts=None),
    "ci_failure": lambda m: record(m, ci_status="failure"),
    "ci_cancelled": lambda m: record(m, ci_status="cancelled"),
    "ci_missing": lambda m: record(m, ci_status=None),
    "ci_not_string": lambda m: record(m, ci_status=True),
    "artifact_missing": lambda m: record(m, artifact=None),
    "artifact_not_object": lambda m: record(m, artifact="npm"),
    "artifact_wrong_registry": lambda m: record(m, artifact=_art(m, registry="pypi")),
    "artifact_wrong_name": lambda m: record(m, artifact=_art(m, name="@evil/pkg")),
    "artifact_name_of_other_registry": lambda m: record(m, artifact=_art(m, name=DOCKER)),
    "artifact_bad_digest": lambda m: record(m, artifact=_art(m, digest="sha256:abc")),
    "artifact_no_digest_prefix": lambda m: record(m, artifact=_art(m, digest="a" * 64)),
    "artifact_version_mismatch": lambda m: record(m, artifact=_art(m, version="9.9.9")),
    "artifact_published_string": lambda m: record(m, artifact=_art(m, published="yes")),
}


@pytest.mark.parametrize("name", sorted(TAMPER))
def test_single_tampered_mirror_is_outvoted(world, name):
    """One bad record among two good ones cannot block the milestone."""
    vid = vault(world)
    bad = TAMPER[name](1)
    r = claim(world.c, world.vm, world.bob, vid, 1, ("ok", bad, "ok"))
    assert r["verdict"] == VERDICT_VERIFIED
    assert r["source_count"] == 3


@pytest.mark.parametrize("name", sorted(TAMPER))
def test_two_tampered_mirrors_cannot_verify(world, name):
    """Two forged mirrors cannot manufacture a verification, and the lone honest
    mirror is outvoted into a rejection that releases nothing."""
    vid = vault(world)
    bad = TAMPER[name](1)
    r = claim(world.c, world.vm, world.bob, vid, 1, (bad, "ok", bad))
    assert r["verdict"] == VERDICT_REJECTED
    assert world.c.get_vault_state(vid)["released"] == "0"


@pytest.mark.parametrize("name", sorted(TAMPER))
def test_identical_forgery_on_all_mirrors_releases_nothing(world, name):
    vid = vault(world)
    bad = TAMPER[name](1)
    r = claim(world.c, world.vm, world.bob, vid, 1, (bad, bad, bad))
    assert r["verdict"] == VERDICT_REJECTED and r["released"] == "0"


@pytest.mark.parametrize("which", ["ci_pending", "ci_queued", "ci_in_progress", "artifact_unpublished"])
def test_lagging_pipeline_counts_as_missing_not_failed(world, which):
    vid = vault(world)
    if which == "artifact_unpublished":
        lag = record(1, artifact=_art(1, published=False))
    else:
        lag = record(1, ci_status=which[3:])
    # CONFIRMED + lag + OUTAGE is the spec's retryable shape.
    r = claim(world.c, world.vm, world.bob, vid, 1, ("ok", lag, "503"))
    assert r["verdict"] == VERDICT_QF
    # With the third mirror healthy, two confirmations still carry the quorum.
    r2 = claim(world.c, world.vm, world.bob, vid, 1, ("ok", lag, "ok"))
    assert r2["verdict"] == VERDICT_VERIFIED


def test_extra_unknown_fields_are_ignored(world):
    vid = vault(world)
    rec = record(1, note="hello", extra={"a": 1})
    r = claim(world.c, world.vm, world.bob, vid, 1, (rec, rec, rec))
    assert r["verdict"] == VERDICT_VERIFIED


def test_ci_status_is_case_insensitive(world):
    vid = vault(world)
    rec = record(1, ci_status="SUCCESS")
    r = claim(world.c, world.vm, world.bob, vid, 1, (rec, rec, "404"))
    assert r["verdict"] == VERDICT_VERIFIED


# ============================================================ SemVer ======
M1_OK = ["v0.1.0-alpha", "v0.1.0-alpha.1", "v1.2.3-beta.7", "v0.0.1-alpha.0", "v10.20.30-beta",
         "v0.1.0-alpha.1.x", "v123456789.0.0-alpha"]
M1_BAD = ["v0.1.0", "v0.1.0-rc.1", "v0.1.0-gamma", "v01.0.0-alpha", "v0.1-alpha", "v0.1.0.0-alpha",
          "0.1.0-alpha", "V0.1.0-alpha", "vv0.1.0-alpha", "v0.1.0-alpha+build", "v0.1.0-",
          "v0.1.0-alpha..1", "v0.1.0-alpha.01", "v-1.0.0-alpha", "v1.0.0-ALPHA", "v0.1.0-alpha_1",
          "v1.a.0-alpha", "v 0.1.0-alpha", "v0.1.0-beta-1", "v1234567890.0.0-alpha", "", "v",
          "v0.1.0-alpha." , "v..-alpha"]


@pytest.mark.parametrize("tag", M1_OK)
def test_semver_tranche1_accepts(world, tag):
    vid = vault(world)
    r = claim_tag(world, vid, 1, tag)
    assert r["verdict"] == VERDICT_VERIFIED and r["release_tag"] == tag


@pytest.mark.parametrize("tag", M1_BAD)
def test_semver_tranche1_rejects(world, tag):
    vid = vault(world)
    r = claim_tag(world, vid, 1, tag)
    assert r["verdict"] == VERDICT_REJECTED


@pytest.mark.parametrize("tag", ["v0.9.0-rc.1", "v1.0.0-rc.1", "v0.5.0-rc", "v2.0.0-rc.10",
                                 "v0.1.0-rc.1", "v0.1.0-rc.0"])
def test_semver_tranche2_accepts(world, tag):
    vid = vault_at(world, 1)
    r = claim_tag(world, vid, 2, tag)
    assert r["verdict"] == VERDICT_VERIFIED


@pytest.mark.parametrize("tag", ["v0.9.0-alpha.1", "v0.9.0", "v0.9.0-rcx.1", "v0.9.0-beta.1",
                                 "v0.0.5-rc.1", "v0.0.9-rc.9", "v0.0.0-rc.1"])
def test_semver_tranche2_rejects(world, tag):
    """Includes valid RCs whose core version does not advance past v0.1.0-alpha.1."""
    vid = vault_at(world, 1)
    r = claim_tag(world, vid, 2, tag)
    assert r["verdict"] == VERDICT_REJECTED


@pytest.mark.parametrize("tag", ["v1.0.0", "v1.0.1", "v2.3.4", "v10.0.0"])
def test_semver_tranche3_accepts(world, tag):
    vid = vault_at(world, 2)
    r = claim_tag(world, vid, 3, tag)
    assert r["verdict"] == VERDICT_VERIFIED


@pytest.mark.parametrize("tag", ["v0.9.9", "v1.0.0-rc.2", "v1.0.0-beta.1", "v0.9.0", "v0.5.0",
                                 "v1.0.0-alpha"])
def test_semver_tranche3_rejects(world, tag):
    """v0.9.0 is a stable-shaped tag but does not exceed v0.9.0-rc.1's major gate."""
    vid = vault_at(world, 2)
    r = claim_tag(world, vid, 3, tag)
    assert r["verdict"] == VERDICT_REJECTED


def test_stable_outranks_its_own_release_candidate(world):
    vid = vault(world)
    claim_tag(world, vid, 1, "v1.0.0-alpha.1")
    assert claim_tag(world, vid, 2, "v1.0.0-rc.1")["verdict"] == VERDICT_VERIFIED
    assert claim_tag(world, vid, 3, "v1.0.0")["verdict"] == VERDICT_VERIFIED


def test_beta_ranks_below_rc_at_same_core(world):
    vid = vault(world)
    claim_tag(world, vid, 1, "v1.0.0-beta.1")
    assert claim_tag(world, vid, 2, "v1.0.0-rc.1")["verdict"] == VERDICT_VERIFIED


def test_alpha_numeric_suffix_advance_is_not_needed_across_kinds(world):
    vid = vault(world)
    claim_tag(world, vid, 1, "v2.0.0-alpha.9")
    assert claim_tag(world, vid, 2, "v1.9.0-rc.1")["verdict"] == VERDICT_REJECTED
    assert claim_tag(world, vid, 2, "v2.0.0-rc.1")["verdict"] == VERDICT_VERIFIED


def test_empty_prefix_vault_requires_bare_tags(world):
    vid = vault(world, tag_prefix="")
    assert claim_tag(world, vid, 1, "v0.1.0-alpha.1", prefix="")["verdict"] == VERDICT_REJECTED
    assert claim_tag(world, vid, 1, "0.1.0-alpha.1", prefix="")["verdict"] == VERDICT_VERIFIED
    assert claim_tag(world, vid, 2, "0.9.0-rc.1", prefix="")["verdict"] == VERDICT_VERIFIED
    assert claim_tag(world, vid, 3, "1.0.0", prefix="")["verdict"] == VERDICT_VERIFIED


def test_v_prefix_vault_rejects_bare_tags(world):
    vid = vault(world)
    assert claim_tag(world, vid, 1, "0.1.0-alpha.1", prefix="")["verdict"] == VERDICT_REJECTED


# ===================================================== sequencing & replay =
def test_must_claim_in_order(world):
    vid = vault(world)
    for m in (2, 3):
        mock_feeds(world.vm, m)
        world.vm.sender = world.bob
        with revert(world, "ERR_MILESTONE_OUT_OF_SEQUENCE"):
            world.c.claim_milestone(vid, m)


def test_cannot_claim_a_tranche_twice(world):
    vid = vault_at(world, 1)
    mock_feeds(world.vm, 1)
    world.vm.sender = world.bob
    with revert(world, "ERR_MILESTONE_OUT_OF_SEQUENCE"):
        world.c.claim_milestone(vid, 1)
    assert world.c.get_vault_state(vid)["released"] == str(DEPOSIT * 2000 // 10000)


@pytest.mark.parametrize("m", [0, 4, 5, 99])
def test_milestone_id_out_of_range(world, m):
    vid = vault(world)
    world.vm.sender = world.bob
    with revert(world, "ERR_INVALID_PARAMS"):
        world.c.claim_milestone(vid, m)


def test_replaying_milestone_1_record_for_milestone_2_fails(world):
    vid = vault_at(world, 1)
    old = record(1)
    r = claim(world.c, world.vm, world.bob, vid, 2, (old, old, old))
    assert r["verdict"] == VERDICT_REJECTED


def test_tag_cannot_be_reused_across_tranches(world):
    vid = vault_at(world, 1)
    # same alpha tag offered for the RC tranche: kind mismatch AND not advancing
    r = claim_tag(world, vid, 2, TAGS[1])
    assert r["verdict"] == VERDICT_REJECTED


def test_vault_complete_after_three_and_no_more_claims(world):
    vid = vault_at(world, 3)
    assert world.c.get_vault_state(vid)["status"] == "COMPLETE"
    world.vm.sender = world.bob
    with revert(world, "ERR_INVALID_STATE"):
        world.c.claim_milestone(vid, 3)


def test_retry_after_quorum_failure_succeeds(world):
    vid = vault(world)
    r1 = claim(world.c, world.vm, world.bob, vid, 1, ("ok", "503", "503"))
    assert r1["verdict"] == VERDICT_QF
    r2 = claim(world.c, world.vm, world.bob, vid, 1, ("ok", "ok", "503"))
    assert r2["verdict"] == VERDICT_VERIFIED
    v = world.c.get_vault_state(vid)
    assert v["attempts"] == 2 and v["tranches_done"] == 1


def test_retry_after_rejection_succeeds(world):
    vid = vault(world)
    assert claim(world.c, world.vm, world.bob, vid, 1, ("404", "404", "404"))["verdict"] == 0
    assert claim(world.c, world.vm, world.bob, vid, 1)["verdict"] == 1


def test_many_outages_never_accumulate_a_penalty(world):
    vid = vault(world)
    for _ in range(12):
        assert claim(world.c, world.vm, world.bob, vid, 1, ("503", "503", "503"))["verdict"] == 2
    v = world.c.get_vault_state(vid)
    assert v["attempts"] == 12 and v["released"] == "0" and v["status"] == "ACTIVE"
    assert v["deposited"] == str(DEPOSIT) and v["reclaimed"] == "0"
    assert claim(world.c, world.vm, world.bob, vid, 1)["verdict"] == 1  # still claimable


def test_attempt_record_is_informational(world):
    vid = vault(world)
    claim(world.c, world.vm, world.bob, vid, 1, ("503", "503", "ok"))
    v = world.c.get_vault_state(vid)
    assert (v["last_verdict"], v["last_source_count"], v["last_milestone"]) == (2, 1, 1)
    assert v["last_attempt_at"] > 0


# ====================================================== access control ====
def test_funder_and_beneficiary_may_claim(world):
    vid = vault(world)
    assert claim(world.c, world.vm, world.alice, vid, 1)["accepted"] is True
    assert claim(world.c, world.vm, world.bob, vid, 2)["accepted"] is True


def test_outsider_cannot_claim(world):
    vid = vault(world)
    mock_feeds(world.vm, 1)
    world.vm.sender = world.charlie
    with revert(world, "ERR_UNAUTHORIZED"):
        world.c.claim_milestone(vid, 1)


def test_outsider_cannot_withdraw_or_reclaim(world):
    vid = vault_at(world, 1)
    world.vm.sender = world.charlie
    with revert(world, "ERR_UNAUTHORIZED"):
        world.c.withdraw_released(vid)
    with revert(world, "ERR_UNAUTHORIZED"):
        world.c.reclaim_unreleased(vid)


def test_funder_cannot_withdraw_beneficiary_funds(world):
    vid = vault_at(world, 1)
    world.vm.sender = world.alice
    with revert(world, "ERR_UNAUTHORIZED"):
        world.c.withdraw_released(vid)


def test_beneficiary_cannot_reclaim(world):
    vid = vault(world, deadline=future(2))
    warp_to(world.vm, future(3))
    world.vm.sender = world.bob
    with revert(world, "ERR_UNAUTHORIZED"):
        world.c.reclaim_unreleased(vid)


@pytest.mark.parametrize("method,args", [
    ("get_vault_state", (42,)), ("get_milestone_status", (42, 1)), ("get_verifier_sources", (42,)),
    ("preview_release", (42, 1)), ("claim_milestone", (42, 1)), ("withdraw_released", (42,)),
    ("reclaim_unreleased", (42,)),
])
def test_unknown_vault_everywhere(world, method, args):
    world.vm.sender = world.bob
    with revert(world, "ERR_INVALID_STATE"):
        getattr(world.c, method)(*args)


# ================================================== pull payments =========
def test_withdraw_released_pays_exactly_the_released_amount(world):
    vid = vault_at(world, 2)
    world.vm.sender = world.bob
    out = world.c.withdraw_released(vid)
    assert out == str(DEPOSIT * 5000 // 10000)
    v = world.c.get_vault_state(vid)
    assert v["withdrawn"] == out and v["withdrawable"] == "0"
    assert v["unreleased"] == str(DEPOSIT - DEPOSIT * 5000 // 10000)
    invariants(world.c)


def test_withdraw_with_nothing_released_fails(world):
    vid = vault(world)
    world.vm.sender = world.bob
    with revert(world, "ERR_NO_WITHDRAWABLE_BALANCE"):
        world.c.withdraw_released(vid)


def test_double_withdraw_fails(world):
    vid = vault_at(world, 1)
    world.vm.sender = world.bob
    world.c.withdraw_released(vid)
    with revert(world, "ERR_NO_WITHDRAWABLE_BALANCE"):
        world.c.withdraw_released(vid)


def test_withdraw_streams_tranche_by_tranche(world):
    vid = vault(world)
    paid = 0
    for m in (1, 2, 3):
        claim(world.c, world.vm, world.bob, vid, m)
        world.vm.sender = world.bob
        paid += int(world.c.withdraw_released(vid))
        assert paid == DEPOSIT * CUM[m] // 10000
        invariants(world.c)
    assert paid == DEPOSIT
    assert world.c.get_protocol_state()["total_escrow"] == "0"


def test_unreleased_tranches_cannot_be_withdrawn(world):
    vid = vault_at(world, 1)
    world.vm.sender = world.bob
    assert int(world.c.withdraw_released(vid)) == DEPOSIT * 2000 // 10000
    with revert(world, "ERR_NO_WITHDRAWABLE_BALANCE"):
        world.c.withdraw_released(vid)
    assert world.c.get_vault_state(vid)["unreleased"] == str(DEPOSIT - DEPOSIT * 2000 // 10000)


def test_rejection_releases_nothing_withdrawable(world):
    vid = vault(world)
    claim(world.c, world.vm, world.bob, vid, 1, ("missing", "missing", "missing"))
    world.vm.sender = world.bob
    with revert(world, "ERR_NO_WITHDRAWABLE_BALANCE"):
        world.c.withdraw_released(vid)


def test_vaults_are_isolated(world):
    v1 = vault(world)
    v2 = vault(world, value=2 * DEPOSIT)
    claim(world.c, world.vm, world.bob, v1, 1)
    a, b = world.c.get_vault_state(v1), world.c.get_vault_state(v2)
    assert a["tranches_done"] == 1 and b["tranches_done"] == 0
    assert b["released"] == "0" and b["deposited"] == str(2 * DEPOSIT)
    invariants(world.c)


def test_solvency_flag_tracks_balance(world):
    vault(world)
    assert world.c.get_protocol_state()["solvent"] is False  # direct mode: not credited
    credit_contract(world.vm, DEPOSIT)
    ps = world.c.get_protocol_state()
    assert ps["solvent"] is True and ps["contract_balance"] == str(DEPOSIT)


# ===================================================== slashing ===========
def test_reclaim_before_deadline_fails(world):
    vid = vault(world, deadline=future(10))
    world.vm.sender = world.alice
    with revert(world, "ERR_DEADLINE_NOT_REACHED"):
        world.c.reclaim_unreleased(vid)


def test_reclaim_full_vault_after_deadline(world):
    vid = vault(world, deadline=future(2))
    warp_to(world.vm, future(3))
    world.vm.sender = world.alice
    out = world.c.reclaim_unreleased(vid)
    assert out == str(DEPOSIT)
    v = world.c.get_vault_state(vid)
    assert v["status"] == "SLASHED" and v["reclaimed"] == str(DEPOSIT) and v["unreleased"] == "0"
    assert all(t["status"] == "SLASHED" for t in v["tranches"])
    ps = invariants(world.c)
    assert ps["total_slashed"] == str(DEPOSIT) and ps["total_escrow"] == "0"


@pytest.mark.parametrize("done", [1, 2])
def test_reclaim_after_partial_progress_only_takes_the_unshipped(world, done):
    vid = vault(world, deadline=future(2))
    for m in range(1, done + 1):
        claim(world.c, world.vm, world.bob, vid, m)
    warp_to(world.vm, future(3))
    world.vm.sender = world.alice
    out = int(world.c.reclaim_unreleased(vid))
    shipped = DEPOSIT * CUM[done] // 10000
    assert out == DEPOSIT - shipped
    # the beneficiary keeps what was earned
    world.vm.sender = world.bob
    assert int(world.c.withdraw_released(vid)) == shipped
    invariants(world.c)
    assert world.c.get_protocol_state()["total_escrow"] == "0"


def test_double_reclaim_fails(world):
    vid = vault(world, deadline=future(2))
    warp_to(world.vm, future(3))
    world.vm.sender = world.alice
    world.c.reclaim_unreleased(vid)
    with revert(world, "ERR_INVALID_STATE"):
        world.c.reclaim_unreleased(vid)


def test_no_claims_after_slash(world):
    vid = vault(world, deadline=future(2))
    warp_to(world.vm, future(3))
    world.vm.sender = world.alice
    world.c.reclaim_unreleased(vid)
    mock_feeds(world.vm, 1)
    world.vm.sender = world.bob
    with revert(world, "ERR_INVALID_STATE"):
        world.c.claim_milestone(vid, 1)


def test_cannot_reclaim_a_completed_vault(world):
    vid = vault_at(world, 3)
    warp_to(world.vm, future(40))
    world.vm.sender = world.alice
    with revert(world, "ERR_INVALID_STATE"):
        world.c.reclaim_unreleased(vid)


def test_claim_after_deadline_before_slash_still_wins(world):
    """The beneficiary who ships late but before the funder slashes keeps the tranche."""
    vid = vault(world, deadline=future(2))
    warp_to(world.vm, future(3))
    assert claim(world.c, world.vm, world.bob, vid, 1)["accepted"] is True


def test_released_tranche_survives_the_slash_for_withdrawal(world):
    vid = vault(world, deadline=future(2))
    claim(world.c, world.vm, world.bob, vid, 1)
    warp_to(world.vm, future(3))
    world.vm.sender = world.alice
    world.c.reclaim_unreleased(vid)
    world.vm.sender = world.bob
    assert int(world.c.withdraw_released(vid)) == DEPOSIT * 2000 // 10000


# ================================================= milestone status view ==
def test_milestone_status_progression(world):
    vid = vault(world)
    s = [world.c.get_milestone_status(vid, m) for m in (1, 2, 3)]
    assert [x["status"] for x in s] == ["PENDING", "LOCKED", "LOCKED"]
    assert [x["claimable_now"] for x in s] == [True, False, False]
    claim(world.c, world.vm, world.bob, vid, 1)
    s = [world.c.get_milestone_status(vid, m) for m in (1, 2, 3)]
    assert [x["status"] for x in s] == ["ACCEPTED", "PENDING", "LOCKED"]
    assert s[0]["release_tag"] == TAGS[1] and s[1]["previous_tag"] == TAGS[1]
    assert [x["claimable_now"] for x in s] == [False, True, False]


def test_milestone_status_source_urls(world):
    vid = vault(world)
    s = world.c.get_milestone_status(vid, 2)
    assert s["source_urls"] == [feed_url("A", 2), feed_url("B", 2), feed_url("C", 2)]
    assert s["kind"] == "RC" and s["bps"] == 3000 and s["vault_id"] == vid


@pytest.mark.parametrize("m", [0, 4, 100])
def test_milestone_status_range(world, m):
    vid = vault(world)
    with revert(world, "ERR_INVALID_PARAMS"):
        world.c.get_milestone_status(vid, m)


def test_milestone_status_reports_slashed(world):
    vid = vault(world, deadline=future(2))
    warp_to(world.vm, future(3))
    world.vm.sender = world.alice
    world.c.reclaim_unreleased(vid)
    assert world.c.get_milestone_status(vid, 1)["status"] == "SLASHED"
    assert world.c.get_milestone_status(vid, 1)["claimable_now"] is False


@pytest.mark.parametrize("m,expected", [(1, 2000), (2, 5000), (3, 10000)])
def test_preview_release_is_cumulative(world, m, expected):
    vid = vault(world)
    assert world.c.preview_release(vid, m) == str(DEPOSIT * expected // 10000)


def test_preview_release_nets_out_released(world):
    vid = vault_at(world, 1)
    assert world.c.preview_release(vid, 2) == str(DEPOSIT * 5000 // 10000 - DEPOSIT * 2000 // 10000)


@pytest.mark.parametrize("m", [0, 4])
def test_preview_release_range(world, m):
    vid = vault(world)
    with revert(world, "ERR_INVALID_PARAMS"):
        world.c.preview_release(vid, m)


# ============================================= vault view completeness ====
def test_tranche_views_are_complete(world):
    vid = vault_at(world, 2)
    v = world.c.get_vault_state(vid)
    assert [t["kind"] for t in v["tranches"]] == ["ALPHA", "RC", "STABLE"]
    assert [t["bps"] for t in v["tranches"]] == [2000, 3000, 5000]
    assert [t["status"] for t in v["tranches"]] == ["ACCEPTED", "ACCEPTED", "PENDING"]
    assert [t["release_tag"] for t in v["tranches"]] == [TAGS[1], TAGS[2], ""]
    assert sum(int(t["amount"]) for t in v["tranches"]) == DEPOSIT
    assert all(t["verified_ts"] > 0 for t in v["tranches"][:2])


# ======================================================= no floats ========
def collect_views(w, vid):
    c = w.c
    out = [c.get_constants(), c.get_protocol_state(), c.get_vault_state(vid),
           c.get_verifier_sources(vid)]
    out += [c.get_milestone_status(vid, m) for m in (1, 2, 3)]
    out += [c.preview_release(vid, m) for m in (1, 2, 3)]
    return out


@pytest.mark.parametrize("stage", ["fresh", "after_outage", "after_reject", "after_t1", "complete"])
def test_no_float_in_any_view(world, stage):
    vid = vault(world)
    if stage == "after_outage":
        claim(world.c, world.vm, world.bob, vid, 1, ("503", "503", "ok"))
    elif stage == "after_reject":
        claim(world.c, world.vm, world.bob, vid, 1, ("missing", "missing", "ok"))
    elif stage == "after_t1":
        claim(world.c, world.vm, world.bob, vid, 1)
    elif stage == "complete":
        ship_all(world.c, world.vm, world.bob, vid)
    for view in collect_views(world, vid):
        for leaf in walk(view):
            assert not isinstance(leaf, float), leaf
            assert isinstance(leaf, (int, str, bool)), type(leaf)
    json.dumps(collect_views(world, vid))


def test_claim_result_has_no_floats(world):
    vid = vault(world)
    for leaf in walk(claim(world.c, world.vm, world.bob, vid, 1)):
        assert not isinstance(leaf, float)


def test_contract_source_has_no_float_operations():
    src = open("contracts/ship_or_slash.py").read()
    import ast
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant):
            assert not isinstance(node.value, float), node.lineno
        if isinstance(node, ast.BinOp):
            assert not isinstance(node.op, ast.Div), node.lineno
        if isinstance(node, ast.Name):
            assert node.id != "float", node.lineno
        if isinstance(node, ast.Attribute):
            assert node.attr != "timestamp", node.lineno


# ======================================================= validators =======
def verified_claim(w, states=("ok", "ok", "ok")):
    vid = vault(w)
    claim(w.c, w.vm, w.bob, vid, 1, states)
    return vid


def test_validator_agrees_with_honest_leader(world):
    verified_claim(world)
    assert world.vm.run_validator() is True


def test_validator_agrees_when_it_sees_a_different_two_of_three(world):
    verified_claim(world, ("ok", "ok", "ok"))
    mock_feeds(world.vm, 1, ("503", "ok", "ok"))  # validator lost mirror A
    assert world.vm.run_validator() is True


def test_validator_rejects_verified_when_mirrors_say_missing(world):
    verified_claim(world)
    mock_feeds(world.vm, 1, ("404", "404", "404"))
    assert world.vm.run_validator() is False


def wrapped(payload=None, commit=COMMITS[1], digest=DIGEST_1):
    """The aggregate's wire shape: five-field payload plus release identity."""
    p = {"verdict": 1, "milestone_id": 1, "source_count": 3, "release_tag": TAGS[1],
         "verified_ts": 1760000001}
    p.update(payload or {})
    return {"payload": p, "commit_sha": commit, "artifact_digest": digest}


def test_validator_rejects_inflated_leader_verdict(world):
    """A leader that fabricates VERIFIED cannot get a validator that sees 404s to agree."""
    vid = vault(world)
    claim(world.c, world.vm, world.bob, vid, 1, ("404", "404", "ok"))
    assert world.vm.run_validator(leader_result=wrapped()) is False


def test_validator_rejects_quorum_failure_when_quorum_exists(world):
    vid = vault(world)
    claim(world.c, world.vm, world.bob, vid, 1, ("503", "503", "ok"))
    mock_feeds(world.vm, 1, ("ok", "ok", "ok"))
    assert world.vm.run_validator() is False


def test_validator_agrees_on_quorum_failure_both_sides(world):
    vid = vault(world)
    claim(world.c, world.vm, world.bob, vid, 1, ("503", "503", "ok"))
    mock_feeds(world.vm, 1, ("ok", "503", "503"))
    assert world.vm.run_validator() is True


def test_validator_agrees_on_rejection(world):
    vid = vault(world)
    claim(world.c, world.vm, world.bob, vid, 1, ("missing", "404", "ok"))
    assert world.vm.run_validator() is True


def test_validator_rejects_rejection_when_it_sees_verification(world):
    vid = vault(world)
    claim(world.c, world.vm, world.bob, vid, 1, ("missing", "404", "ok"))
    mock_feeds(world.vm, 1, ("ok", "ok", "ok"))
    assert world.vm.run_validator() is False


def test_validator_rejects_different_release_tag(world):
    verified_claim(world)
    rec = record(1, release_tag="v0.1.0-alpha.2",
                 artifact=dict(record(1)["artifact"], version="0.1.0-alpha.2"))
    mock_feeds(world.vm, 1, (rec, rec, rec))
    assert world.vm.run_validator() is False


def test_validator_ignores_source_count_and_timestamp_noise(world):
    verified_claim(world)
    lead = wrapped({"source_count": 2, "verified_ts": 1760009999})
    assert world.vm.run_validator(leader_result=lead) is True


def test_validator_agrees_with_the_exact_identity(world):
    verified_claim(world)
    assert world.vm.run_validator(leader_result=wrapped()) is True


def test_validator_rejects_same_tag_with_a_different_commit(world):
    """The tag alone does not identify a release: a leader that points the same
    tag at another commit is not agreed with."""
    verified_claim(world)
    assert world.vm.run_validator(leader_result=wrapped(commit="f" * 40)) is False


def test_validator_rejects_same_tag_with_a_different_artifact_digest(world):
    verified_claim(world)
    assert world.vm.run_validator(leader_result=wrapped(digest="sha256:" + "e" * 64)) is False


def test_validator_that_sees_a_different_commit_disagrees(world):
    verified_claim(world)
    other = record(1, commit_sha="f" * 40)
    mock_feeds(world.vm, 1, (other, other, other))
    assert world.vm.run_validator() is False


def test_validator_that_sees_a_different_digest_disagrees(world):
    verified_claim(world)
    art = dict(record(1)["artifact"], digest="sha256:" + "d" * 64)
    other = record(1, artifact=art)
    mock_feeds(world.vm, 1, (other, other, other))
    assert world.vm.run_validator() is False


def test_validator_agrees_when_only_the_timestamp_differs(world):
    verified_claim(world)
    other = record(1, verified_ts=1760099999)
    mock_feeds(world.vm, 1, (other, other, other))
    assert world.vm.run_validator() is True


def test_validator_disagrees_with_a_leader_error(world):
    verified_claim(world)
    assert world.vm.run_validator(leader_error=Exception("leader crashed")) is False


@pytest.mark.parametrize("bad", [
    {"verdict": 1, "milestone_id": 1, "source_count": 3, "release_tag": TAGS[1]},  # missing field
    {"verdict": 1, "milestone_id": 1, "source_count": 3, "release_tag": TAGS[1],
     "verified_ts": 1, "extra": 1},  # extra field
    {"verdict": True, "milestone_id": 1, "source_count": 3, "release_tag": TAGS[1], "verified_ts": 1},
    {"verdict": 1.0, "milestone_id": 1, "source_count": 3, "release_tag": TAGS[1], "verified_ts": 1},
    {"verdict": 3, "milestone_id": 1, "source_count": 3, "release_tag": "", "verified_ts": 0},
    {"verdict": -1, "milestone_id": 1, "source_count": 3, "release_tag": "", "verified_ts": 0},
    {"verdict": 1, "milestone_id": 2, "source_count": 3, "release_tag": TAGS[1], "verified_ts": 1},
    {"verdict": 1, "milestone_id": 1, "source_count": 3, "release_tag": "", "verified_ts": 1},
    {"verdict": 1, "milestone_id": 1, "source_count": 3, "release_tag": TAGS[1], "verified_ts": 0},
    {"verdict": 1, "milestone_id": 1, "source_count": 1, "release_tag": TAGS[1], "verified_ts": 1},
    {"verdict": 2, "milestone_id": 1, "source_count": 3, "release_tag": "", "verified_ts": 0},
    {"verdict": 2, "milestone_id": 1, "source_count": 1, "release_tag": TAGS[1], "verified_ts": 0},
    {"verdict": 0, "milestone_id": 1, "source_count": 1, "release_tag": "", "verified_ts": 0},
    {"verdict": 0, "milestone_id": 1, "source_count": 2, "release_tag": "", "verified_ts": 5},
    {"verdict": 1, "milestone_id": 1, "source_count": 3, "release_tag": 7, "verified_ts": 1},
    {"verdict": 1, "milestone_id": 1, "source_count": 4, "release_tag": TAGS[1], "verified_ts": 1},
    {"verdict": 1, "milestone_id": 1, "source_count": 3, "release_tag": TAGS[1], "verified_ts": 1.5},
    "not a dict", None, [],
])
def test_validator_rejects_malformed_leader_payload(world, bad):
    """A malformed five-field payload, wrapped in an otherwise valid wrapper,
    is rejected on the payload's own merits. Non-dict inputs are passed bare."""
    verified_claim(world)
    lead = bad if not isinstance(bad, dict) else {
        "payload": bad, "commit_sha": COMMITS[1], "artifact_digest": DIGEST_1}
    assert world.vm.run_validator(leader_result=lead) is False


@pytest.mark.parametrize("bad", [
    {"payload": wrapped()["payload"], "commit_sha": COMMITS[1]},  # no digest
    {"payload": wrapped()["payload"], "artifact_digest": DIGEST_1},  # no commit
    {**wrapped(), "extra": 1},
    wrapped(commit=""),  # VERIFIED without a commit
    wrapped(digest=""),  # VERIFIED without a digest
    wrapped(commit="A" * 40),  # upper-case hex
    wrapped(commit="a" * 39),
    wrapped(digest="sha256:" + "a" * 63),
    wrapped(digest="md5:" + "a" * 64),
    wrapped(digest="a" * 64),  # no scheme prefix
    wrapped(commit=7),
    wrapped(digest=None),
    wrapped({"verdict": 0, "source_count": 2, "release_tag": "", "verified_ts": 0}),  # identity on a non-VERIFIED
    wrapped({"verdict": 2, "source_count": 1, "release_tag": "", "verified_ts": 0}),
])
def test_validator_rejects_malformed_identity(world, bad):
    verified_claim(world)
    assert world.vm.run_validator(leader_result=bad) is False


def test_validator_accepts_a_wellformed_non_verified_wrapper_with_empty_identity(world):
    vid = vault(world)
    claim(world.c, world.vm, world.bob, vid, 1, ("404", "404", "ok"))
    lead = {"payload": {"verdict": 0, "milestone_id": 1, "source_count": 3, "release_tag": "",
                        "verified_ts": 0}, "commit_sha": "", "artifact_digest": ""}
    assert world.vm.run_validator(leader_result=lead) is True


# ====================================== adversarial / cross-vault ==========
def test_record_for_another_repo_never_satisfies_this_vault(world):
    vid = vault(world, repo_url="https://github.com/other/project")
    r = claim(world.c, world.vm, world.bob, vid, 1)  # mirrors serve SOBEK96/ShipOrSlash
    assert r["verdict"] == VERDICT_REJECTED


def test_vault_bound_to_a_different_signer_rejects_valid_signed_records(world):
    vid = vault(world, signer_fp_hash=OTHER_SIGNER_HASH)
    r = claim(world.c, world.vm, world.bob, vid, 1)
    assert r["verdict"] == VERDICT_REJECTED


def test_vault_bound_to_docker_only_rejects_npm_artifacts(world):
    vid = vault(world, npm_package="")
    r = claim(world.c, world.vm, world.bob, vid, 1)  # records carry the npm artifact
    assert r["verdict"] == VERDICT_REJECTED
    r2 = claim(world.c, world.vm, world.bob, vid, 1, ("ok_docker", "ok_docker", "ok_docker"))
    assert r2["verdict"] == VERDICT_VERIFIED


def test_vault_bound_to_npm_only_rejects_docker_artifacts(world):
    vid = vault(world, docker_image="")
    r = claim(world.c, world.vm, world.bob, vid, 1, ("ok_docker", "ok_docker", "ok_docker"))
    assert r["verdict"] == VERDICT_REJECTED


def test_unmocked_feeds_are_an_outage_not_a_crash(world):
    vid = vault(world)
    world.vm.clear_mocks()
    world.vm.sender = world.bob
    r = world.c.claim_milestone(vid, 1)
    assert r["verdict"] == VERDICT_QF and r["source_count"] == 0


@pytest.mark.parametrize("suffix", ["milestone_01.json", "milestone_1", "milestone-1.json",
                                    "Milestone_1.json", "milestone_1.json.bak", "index.json"])
def test_only_the_exact_milestone_file_name_is_read(world, suffix):
    """Mirrors serving the record under any other name are unreachable, not trusted."""
    import re
    vid = vault(world)
    world.vm.clear_mocks()
    for slot in SLOTS:
        world.vm.mock_web("^" + re.escape(BASES[slot] + suffix) + "$",
                          {"status": 200, "body": json.dumps(record(1))})
    world.vm.sender = world.bob
    r = world.c.claim_milestone(vid, 1)
    assert r["verdict"] == VERDICT_QF and r["source_count"] == 0


# ================================================ randomized invariants ===
def run_sequence(w, seed):
    import random
    rng = random.Random(seed)
    dep = rng.choice([MIN_DEPOSIT, DEPOSIT, 3 * ATTO + 11, 123456789123456789])
    vid = create(w.c, w.vm, w.alice, w.bob, value=dep, deadline=future(3))
    pools = [("ok", "ok", "ok"), ("ok", "ok", "503"), ("ok", "404", "503"), ("503", "503", "ok"),
             ("missing", "missing", "ok"), ("ok", "missing", "404"), ("404", "404", "404"),
             ("ok", "503", "ok")]
    for _ in range(rng.randint(6, 16)):
        op = rng.choice(["claim", "claim", "claim", "withdraw", "topup"])
        try:
            if op == "claim":
                v = w.c.get_vault_state(vid)
                if v["status"] != "ACTIVE":
                    continue
                claim(w.c, w.vm, rng.choice([w.alice, w.bob]), vid, v["tranches_done"] + 1,
                      rng.choice(pools))
            elif op == "withdraw":
                w.vm.sender = w.bob
                w.c.withdraw_released(vid)
            else:
                top_up(w, w.alice, vid, rng.choice([MIN_DEPOSIT, DEPOSIT]))
        except Exception as e:  # expected business errors only
            assert any(t in str(e) for t in ("ERR_NO_WITHDRAWABLE_BALANCE", "ERR_INVALID_STATE")), e
        invariants(w.c)
    # close out: slash whatever is left, withdraw whatever was earned
    warp_to(w.vm, future(4))
    v = w.c.get_vault_state(vid)
    if v["status"] == "ACTIVE":
        w.vm.sender = w.alice
        w.c.reclaim_unreleased(vid)
    v = w.c.get_vault_state(vid)
    if int(v["withdrawable"]) > 0:
        w.vm.sender = w.bob
        w.c.withdraw_released(vid)
    ps = invariants(w.c)
    assert ps["total_escrow"] == "0"
    v = w.c.get_vault_state(vid)
    assert int(v["withdrawn"]) + int(v["reclaimed"]) == int(v["deposited"])


@pytest.mark.parametrize("seed", range(16))
def test_random_operation_sequences_conserve_value(world, seed):
    run_sequence(world, seed)


def test_value_conservation_across_many_vaults(world):
    ids = [vault(world, value=DEPOSIT + i) for i in range(5)]
    for i, vid in enumerate(ids):
        ship_all(world.c, world.vm, world.bob, vid, upto=(i % 3) + 1)
    ps = invariants(world.c)
    assert int(ps["total_escrow"]) == sum(DEPOSIT + i for i in range(5))
    for vid in ids:
        v = world.c.get_vault_state(vid)
        if int(v["withdrawable"]) > 0:
            world.vm.sender = world.bob
            world.c.withdraw_released(vid)
    invariants(world.c)


# ================================================ committed fixture files ==
def _fixture(slot, m):
    import os
    p = os.path.join("deployments", "mock_feeds", slot, f"milestone_{m}.json")
    with open(p) as f:
        return json.load(f)


@pytest.mark.parametrize("m", [1, 2, 3])
@pytest.mark.parametrize("slot", ["a", "b", "c"])
def test_committed_fixture_is_a_valid_record(slot, m):
    rec = _fixture(slot, m)
    assert rec["schema"] == "shiporslash/v1" and rec["milestone_id"] == m
    assert rec["repo_url"] == REPO and rec["signer_fingerprint_sha256"] == SIGNER_HASH
    assert rec["found"] is True and rec["signature_verified"] is True
    assert rec["ci_status"] == "success" and rec["artifact"]["published"] is True
    assert all(not isinstance(v, float) for v in walk(rec))


def test_committed_fixtures_ship_all_three_tranches(world):
    """The exact files the live deployment reads carry a vault to COMPLETE."""
    vid = vault(world)
    for m in (1, 2, 3):
        recs = tuple(_fixture(s, m) for s in ("a", "b", "c"))
        r = claim(world.c, world.vm, world.bob, vid, m, recs)
        assert r["verdict"] == VERDICT_VERIFIED and r["source_count"] == 3, (m, r)
        assert r["release_tag"] == TAGS[m]
    v = world.c.get_vault_state(vid)
    assert v["status"] == "COMPLETE" and v["released"] == str(DEPOSIT)


def test_committed_fixtures_have_distinct_slot_timestamps():
    ts = {s: _fixture(s, 1)["verified_ts"] for s in ("a", "b", "c")}
    assert len(set(ts.values())) == 3  # three independent observations, not one copy


# ============================================ release identity is recorded ==
def art_with(m, **over):
    return dict(record(m)["artifact"], **over)


def test_accepted_tranche_records_commit_and_digest(world):
    vid = vault(world)
    r = claim(world.c, world.vm, world.bob, vid, 1)
    assert r["commit_sha"] == COMMITS[1] and r["artifact_digest"] == DIGEST_1
    t = world.c.get_vault_state(vid)["tranches"][0]
    assert t["commit_sha"] == COMMITS[1] and t["artifact_digest"] == DIGEST_1
    m = world.c.get_milestone_status(vid, 1)
    assert m["commit_sha"] == COMMITS[1] and m["artifact_digest"] == DIGEST_1


@pytest.mark.parametrize("states", [("404", "404", "ok"), ("503", "503", "ok"), ("missing", "ok", "404")])
def test_unaccepted_outcome_records_no_identity(world, states):
    vid = vault(world)
    r = claim(world.c, world.vm, world.bob, vid, 1, states)
    assert r["commit_sha"] == "" and r["artifact_digest"] == ""
    t = world.c.get_vault_state(vid)["tranches"][0]
    assert t["commit_sha"] == "" and t["artifact_digest"] == ""


def test_all_three_tranches_record_distinct_identities(world):
    vid = vault_at(world, 3)
    ts = world.c.get_vault_state(vid)["tranches"]
    assert [t["commit_sha"] for t in ts] == [COMMITS[1], COMMITS[2], COMMITS[3]]
    assert [t["artifact_digest"] for t in ts] == [DIGEST_1, DIGEST_2, DIGEST_3]


def test_two_mirrors_must_agree_on_the_artifact_digest(world):
    """Same tag, same commit, different digests: no corroboration."""
    vid = vault(world)
    a = record(1, artifact=art_with(1, digest="sha256:" + "a" * 64))
    b = record(1, artifact=art_with(1, digest="sha256:" + "b" * 64))
    assert claim(world.c, world.vm, world.bob, vid, 1, (a, b, "404"))["verdict"] == VERDICT_REJECTED
    assert claim(world.c, world.vm, world.bob, vid, 1, (a, b, "503"))["verdict"] == VERDICT_QF
    # the third mirror breaks the tie in favour of the digest it agrees with
    r = claim(world.c, world.vm, world.bob, vid, 1, (a, b, a))
    assert r["verdict"] == VERDICT_VERIFIED and r["artifact_digest"] == "sha256:" + "a" * 64


def test_two_mirrors_must_agree_on_the_commit(world):
    vid = vault(world)
    r = claim(world.c, world.vm, world.bob, vid, 1,
              (record(1), record(1, commit_sha="c" * 40), record(1, commit_sha="c" * 40)))
    assert r["verdict"] == VERDICT_VERIFIED and r["commit_sha"] == "c" * 40


def test_a_commit_that_earned_a_tranche_cannot_earn_another(world):
    vid = vault_at(world, 1)
    again = tag_record(2, TAGS[2], commit_sha=COMMITS[1])
    r = claim(world.c, world.vm, world.bob, vid, 2, (again, again, again))
    assert r["verdict"] == VERDICT_REJECTED and r["released"] == "0"


def test_an_artifact_digest_that_earned_a_tranche_cannot_earn_another(world):
    vid = vault_at(world, 1)
    again = record(2, artifact=art_with(2, digest=DIGEST_1))
    r = claim(world.c, world.vm, world.bob, vid, 2, (again, again, again))
    assert r["verdict"] == VERDICT_REJECTED


def test_reuse_check_spans_every_earlier_tranche(world):
    vid = vault_at(world, 2)
    again = tag_record(3, TAGS[3], commit_sha=COMMITS[1])  # tranche 1's commit, offered for tranche 3
    assert claim(world.c, world.vm, world.bob, vid, 3, (again, again, again))["verdict"] == VERDICT_REJECTED
    again = record(3, artifact=art_with(3, digest=DIGEST_2))
    assert claim(world.c, world.vm, world.bob, vid, 3, (again, again, again))["verdict"] == VERDICT_REJECTED
    assert claim(world.c, world.vm, world.bob, vid, 3)["verdict"] == VERDICT_VERIFIED


def test_a_fresh_build_is_accepted_after_a_reuse_attempt(world):
    vid = vault_at(world, 1)
    bad = tag_record(2, TAGS[2], commit_sha=COMMITS[1])
    assert claim(world.c, world.vm, world.bob, vid, 2, (bad, bad, bad))["verdict"] == VERDICT_REJECTED
    assert claim(world.c, world.vm, world.bob, vid, 2)["verdict"] == VERDICT_VERIFIED


# ====================== projected tranche amounts equal what a claim pays ==
def topup(w, vid, amount):
    fund(w.vm, w.alice)
    w.vm.sender = w.alice
    w.vm.value = amount
    try:
        w.c.top_up_vault(vid)
    finally:
        w.vm.value = 0


def _scenario(w, deposit, topups):
    """Runs a vault through three claims, applying top-ups after the given
    tranche counts, and records what the contract projected before each claim,
    what preview_release said, and what the claim actually paid."""
    vid = create(w.c, w.vm, w.alice, w.bob, value=deposit)
    steps = []
    for m in (1, 2, 3):
        for t in topups:
            if t["after"] == m - 1:
                topup(w, vid, int(t["amount"]))
        v = w.c.get_vault_state(vid)
        projected = [t["amount"] for t in v["tranches"]]
        preview = w.c.preview_release(vid, m)
        r = claim(w.c, w.vm, w.bob, vid, m)
        steps.append({
            "tranche": m,
            "deposited": v["deposited"],
            "released_before": v["released"],
            "projected_all": projected,
            "projected": projected[m - 1],
            "preview": preview,
            "paid": r["released"],
        })
    return {"deposit": str(deposit), "topups": topups, "steps": steps}


VECTOR_SCENARIOS = [
    (1_000_000_000_000_000, []),
    (1_000_000_000_000_001, []),
    (1_000_000_000_000_003, []),
    (123_456_789_012_345_678, []),
    (10**18, []),
    (700_000_000_000_000_001, []),
    (3 * 10**18 + 7, []),
    (2**64 + 1, []),
    (10**18, [{"after": 1, "amount": str(10**18)}]),
    (10**18, [{"after": 0, "amount": str(10**15 + 1)}]),
    (10**18 + 3, [{"after": 1, "amount": "1000000000000007"}, {"after": 2, "amount": "2000000000000009"}]),
    (5 * 10**17, [{"after": 2, "amount": str(10**18 + 11)}]),
    (1_000_000_000_000_001, [{"after": 1, "amount": "1000000000000001"}]),
]


@pytest.mark.parametrize("deposit,topups", VECTOR_SCENARIOS,
                         ids=[f"d{i}" for i in range(len(VECTOR_SCENARIOS))])
def test_projection_equals_preview_equals_payout(world, deposit, topups):
    sc = _scenario(world, deposit, topups)
    total = deposit + sum(int(t["amount"]) for t in topups)
    paid = 0
    for st in sc["steps"]:
        assert st["projected"] == st["preview"] == st["paid"], st
        # the three tranche amounts shown always account for the whole deposit
        assert sum(int(a) for a in st["projected_all"]) == int(st["deposited"])
        paid += int(st["paid"])
    assert paid == total
    invariants(world.c)


def test_view_amounts_sum_to_the_deposit_after_a_top_up(world):
    vid = vault_at(world, 1)
    topup(world, vid, DEPOSIT)
    v = world.c.get_vault_state(vid)
    assert sum(int(t["amount"]) for t in v["tranches"]) == int(v["deposited"]) == 2 * DEPOSIT
    # the next tranche shows its catch-up share, and later ones their nominal share
    assert int(v["tranches"][1]["amount"]) == 2 * DEPOSIT * 5000 // 10000 - DEPOSIT * 2000 // 10000
    assert int(v["tranches"][2]["amount"]) == 2 * DEPOSIT - 2 * DEPOSIT * 5000 // 10000


def test_parity_vectors_file_is_current(world):
    """tests/vectors/tranche_parity.json is replayed by the frontend suite, so it
    must be exactly what the contract produces. Regenerate with
    SHIPORSLASH_REGEN_VECTORS=1."""
    import os
    path = os.path.join("tests", "vectors", "tranche_parity.json")
    scenarios = []
    for deposit, topups in VECTOR_SCENARIOS:
        scenarios.append(_scenario(world, deposit, topups))
        # fresh state per scenario: a new contract instance is not needed because
        # vault ids are independent, and every vault is isolated.
    doc = {"generated_by": "tests/test_ship_or_slash.py::test_parity_vectors_file_is_current",
           "rule": "amount = deposited * cumulative_bps // 10000; next tranche pays that minus released",
           "scenarios": scenarios}
    if os.environ.get("SHIPORSLASH_REGEN_VECTORS") == "1":
        with open(path, "w") as f:
            json.dump(doc, f, indent=1, sort_keys=True)
            f.write("\n")
    with open(path) as f:
        assert json.load(f) == json.loads(json.dumps(doc, sort_keys=True))


@pytest.mark.parametrize("m", [1, 2, 3])
def test_committed_fixtures_share_one_release_identity(m):
    """Mirrors corroborate on (tag, commit, registry, digest): the demo feeds must
    attest the same artifact on all three hosts or no quorum could ever form."""
    recs = [_fixture(s, m) for s in ("a", "b", "c")]
    ident = {(r["release_tag"], r["commit_sha"], r["artifact"]["registry"], r["artifact"]["digest"]) for r in recs}
    assert len(ident) == 1


def test_committed_fixtures_distinct_identity_per_tranche():
    commits = {_fixture("a", m)["commit_sha"] for m in (1, 2, 3)}
    digests = {_fixture("a", m)["artifact"]["digest"] for m in (1, 2, 3)}
    assert len(commits) == 3 and len(digests) == 3  # one build earns one tranche


def test_committed_fixtures_record_their_identity_on_chain(world):
    vid = vault(world)
    for m in (1, 2, 3):
        recs = tuple(_fixture(s, m) for s in ("a", "b", "c"))
        r = claim(world.c, world.vm, world.bob, vid, m, recs)
        assert r["commit_sha"] == recs[0]["commit_sha"]
        assert r["artifact_digest"] == recs[0]["artifact"]["digest"]
