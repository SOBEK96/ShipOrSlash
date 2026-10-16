# v0.3.0
# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }

# ShipOrSlash: milestone-bound token vesting with code-verified releases.
#
# A funder escrows native GEN in a vault bound to a repository registry and
# three verifier mirrors. Because the FUNDER chooses those mirrors, a new vault
# is only an offer (PENDING_ACCEPTANCE): the beneficiary must inspect it and
# call accept_vault_terms() inside a 48-hour window. If they reject it or let
# it lapse, the funder recovers 100% of the principal (cancel_vault). Once
# accepted, three fixed tranches (20/30/50%) unlock when two of three
# independent mirrors corroborate a signed, CI-passing, published SemVer
# release. A release is rejected only on positive proof of failure (two mirrors
# explicitly reporting it invalid); 404s, in-flight CI and outages are lag and
# are retryable. No Python float anywhere; no LLM.

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TypeGuard
from urllib.parse import urlsplit

import genlayer as gl
from genlayer import Address, u256
from genlayer.storage import TreeMap

# genvm-lint requires the bare name `allow_storage` on storage dataclasses.
allow_storage = gl.storage.allow

# --- Error classification ---------------------------------------------------
ERR_UNAUTHORIZED = "ERR_UNAUTHORIZED"
ERR_STATE = "ERR_INVALID_STATE"
ERR_PARAMS = "ERR_INVALID_PARAMS"
ERR_REGISTRY = "ERR_INVALID_REGISTRY"
ERR_FEEDS = "ERR_INVALID_VERIFIER_FEEDS"
ERR_DEPOSIT = "ERR_DEPOSIT_BELOW_FLOOR"
ERR_SEQUENCE = "ERR_MILESTONE_OUT_OF_SEQUENCE"
ERR_NO_BALANCE = "ERR_NO_WITHDRAWABLE_BALANCE"
ERR_NOT_EXPIRED = "ERR_DEADLINE_NOT_REACHED"
ERR_TRANSFER = "ERR_TRANSFER_FAILED_RESTORED"
ERR_PAYLOAD = "ERR_INVALID_VERIFIER_PAYLOAD"
ERR_WINDOW = "ERR_ACCEPTANCE_WINDOW"

# --- Verdicts (the only three the aggregate can produce) --------------------
VERDICT_REJECTED = 0
VERDICT_VERIFIED = 1
VERDICT_QUORUM_FAILURE = 2

# --- Per-source states ------------------------------------------------------
SRC_CONFIRMED = "CONFIRMED"
SRC_FAILED = "FAILED"
SRC_NOT_FOUND = "NOT_FOUND"
SRC_OUTAGE = "OUTAGE"

# --- Vault status -----------------------------------------------------------
ST_ACTIVE = "ACTIVE"
ST_COMPLETE = "COMPLETE"
ST_SLASHED = "SLASHED"
ST_PENDING = "PENDING_ACCEPTANCE"  # an offer: nothing can be claimed yet
ST_REJECTED = "REJECTED"  # the beneficiary declined; the funder may cancel
ST_CANCELLED = "CANCELLED"  # principal returned to the funder

# --- Tranche buckets (integer basis points, 10000 == 100%) ------------------
BPS_DENOM = 10000
TRANCHE_BPS = (2000, 3000, 5000)  # ALPHA 20% / RC 30% / STABLE 50%
CUM_BPS = (0, 2000, 5000, 10000)  # cumulative entitlement after tranche k
TRANCHE_KIND = ("", "ALPHA", "RC", "STABLE")  # index == milestone_id
TRANCHES = 3

# --- Verification limits ----------------------------------------------------
SCHEMA = "shiporslash/v1"
QUORUM = 2
SOURCES = 3
MAX_BODY_BYTES = 32768
MAX_URL_LEN = 300
MAX_NAME_LEN = 100
MAX_TAG_LEN = 64
SLOTS = ("A", "B", "C")

# --- Economics (atto-scale: value * 10 ** 18) -------------------------------
ATTO = 10**18
MIN_DEPOSIT = ATTO // 1000  # 0.001 GEN: every tranche is strictly positive
ACCEPTANCE_WINDOW = 2 * 86400  # the beneficiary has 48 hours to inspect and accept
MIN_WINDOW = 86400  # once accepted, a vault still runs at least one full day
# The deadline must leave the whole acceptance window usable AND a full day
# after it, so a beneficiary who accepts at the last moment is never left with
# less than MIN_WINDOW to ship.
MIN_DEADLINE_WINDOW = ACCEPTANCE_WINDOW + MIN_WINDOW
MAX_WINDOW = 5 * 365 * 86400  # ... and at most five years
GENESIS_ZERO = "0x0000000000000000000000000000000000000000"

# --- Operator identity ------------------------------------------------------
# Hosts are not enough for independence: raw.githubusercontent.com and
# api.github.com are different hostnames run by the same operator. Known
# suffixes map to one operator id; anything else falls back to its last two
# DNS labels.
OPERATOR_SUFFIXES = (
    ("githubusercontent.com", "github"),
    ("github.com", "github"),
    ("github.io", "github"),
    ("jsdelivr.net", "jsdelivr"),
    ("githack.com", "githack"),
    ("gitlab.com", "gitlab"),
    ("gitlab.io", "gitlab"),
    ("npmjs.org", "npm"),
    ("npmjs.com", "npm"),
    ("unpkg.com", "unpkg"),
    ("docker.io", "docker"),
    ("docker.com", "docker"),
)
REPO_HOSTS = ("github.com", "gitlab.com")
HEX = "0123456789abcdef"
NAME_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
HOST_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789.-"
SEMVER_ID_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"
CI_PENDING = ("pending", "queued", "in_progress", "waiting", "requested")


# =============================================================================
# Pure helpers (module level: no storage, no clock, safe to pickle)
# =============================================================================
def _is_int(x) -> TypeGuard[int]:
    """A real integer. bool is an int subclass and float is rejected."""
    return isinstance(x, int) and not isinstance(x, bool)


def _is_hex(s, n: int) -> bool:
    return isinstance(s, str) and len(s) == n and all(c in HEX for c in s)


def _printable(s: str, maxlen: int) -> bool:
    return (
        isinstance(s, str)
        and 0 < len(s) <= maxlen
        and all(32 <= ord(c) < 127 for c in s)
    )


def _canon_hash(h: str) -> str:
    """Lowercase 64-hex digest, `0x` prefix tolerated. "" when malformed."""
    if not isinstance(h, str):
        return ""
    s = h.strip().lower()
    if s.startswith("0x"):
        s = s[2:]
    return s if _is_hex(s, 64) else ""


def _norm_repo(url) -> str:
    """Canonical repository URL: https://<github.com|gitlab.com>/<owner>/<repo>,
    lowercase, no `.git`, no credentials/port/query/fragment. "" if malformed."""
    if not isinstance(url, str) or not url or len(url) > MAX_URL_LEN:
        return ""
    if "\\" in url or any(ord(c) < 33 or ord(c) > 126 for c in url):
        return ""
    try:
        p = urlsplit(url)
        port = p.port
    except ValueError:
        return ""
    host = (p.hostname or "").lower()
    if p.scheme != "https" or host not in REPO_HOSTS:
        return ""
    if port is not None or p.username is not None or p.password is not None:
        return ""
    if p.query or p.fragment:
        return ""
    path = p.path.strip("/")
    if path.endswith(".git"):
        path = path[:-4]
    segs = path.split("/")
    if len(segs) != 2:
        return ""
    for seg in segs:
        if seg in ("", ".", "..") or not all(c in NAME_CHARS for c in seg):
            return ""
    return "https://" + host + "/" + segs[0].lower() + "/" + segs[1].lower()


def _feed_host(url) -> str:
    """Hostname of a verifier base URL, or "" when the URL is unsafe.

    Requires https, a DNS name (no IP literal / localhost / internal suffix),
    no credentials, no port, no query or fragment, and a trailing slash so the
    milestone file name can be appended deterministically."""
    if not isinstance(url, str) or not url or len(url) > MAX_URL_LEN:
        return ""
    if "\\" in url or any(ord(c) < 33 or ord(c) > 126 for c in url):
        return ""
    try:
        p = urlsplit(url)
        port = p.port
    except ValueError:
        return ""
    host = (p.hostname or "").lower()
    if p.scheme != "https" or not host or port is not None:
        return ""
    if p.username is not None or p.password is not None or p.query or p.fragment:
        return ""
    if not p.path.endswith("/") or "." not in host:
        return ""
    if not all(c in HOST_CHARS for c in host):
        return ""
    labels = host.split(".")
    if any(l == "" or l.startswith("-") or l.endswith("-") for l in labels):
        return ""
    if labels[-1].isdigit() or host == "localhost":
        return ""
    for bad in (".local", ".localhost", ".internal", ".lan", ".home", ".corp"):
        if host.endswith(bad):
            return ""
    return host


def _operator(host: str) -> str:
    for suffix, op in OPERATOR_SUFFIXES:
        if host == suffix or host.endswith("." + suffix):
            return op
    labels = host.split(".")
    return ".".join(labels[-2:])


def _parse_semver(tag, prefix: str):
    """Strict SemVer 2.0.0 (no build metadata). Returns
    (major, minor, patch, pre_ids) or None. `prefix` is "" or "v" and must be
    present exactly."""
    if not isinstance(tag, str) or not tag or len(tag) > MAX_TAG_LEN:
        return None
    if prefix:
        if not tag.startswith(prefix):
            return None
        tag = tag[len(prefix):]
    if not tag or "+" in tag or tag[0] in "vV":
        return None
    core, sep, pre = tag.partition("-")
    parts = core.split(".")
    if len(parts) != 3:
        return None
    nums = []
    for part in parts:
        if not part.isascii() or not part.isdigit() or len(part) > 9:
            return None
        if len(part) > 1 and part[0] == "0":
            return None
        nums.append(int(part))
    pre_ids = []
    if sep:
        if not pre:
            return None
        for ident in pre.split("."):
            if ident == "" or not all(c in SEMVER_ID_CHARS for c in ident):
                return None
            if ident.isdigit() and len(ident) > 1 and ident[0] == "0":
                return None
            pre_ids.append(ident)
    return (nums[0], nums[1], nums[2], tuple(pre_ids))


def _id_cmp(a: str, b: str) -> int:
    an, bn = a.isdigit(), b.isdigit()
    if an and bn:
        ai, bi = int(a), int(b)
        return (ai > bi) - (ai < bi)
    if an != bn:
        return -1 if an else 1  # numeric identifiers rank below alphanumeric
    return (a > b) - (a < b)


def _semver_cmp(a, b) -> int:
    """SemVer precedence: -1, 0, 1."""
    ca, cb = a[:3], b[:3]
    if ca != cb:
        return -1 if ca < cb else 1
    pa, pb = a[3], b[3]
    if not pa and not pb:
        return 0
    if not pa:
        return 1  # a release outranks its own pre-release
    if not pb:
        return -1
    for x, y in zip(pa, pb):
        c = _id_cmp(x, y)
        if c != 0:
            return c
    return (len(pa) > len(pb)) - (len(pa) < len(pb))


def _kind_ok(parsed, milestone_id: int) -> bool:
    """Per-tranche SemVer shape: 1 = alpha/beta pre-release, 2 = release
    candidate, 3 = stable >= 1.0.0 with no pre-release."""
    pre = parsed[3]
    if milestone_id == 1:
        return len(pre) >= 1 and pre[0] in ("alpha", "beta")
    if milestone_id == 2:
        return len(pre) >= 1 and pre[0] == "rc"
    if milestone_id == 3:
        return len(pre) == 0 and parsed[0] >= 1
    return False


def _cum_entitlement(deposited: int, tranche: int) -> int:
    """Cumulative amount owed once `tranche` tranches are accepted. Integer
    floor division; tranche 3 is the exact remainder, so no dust is stranded."""
    return deposited * CUM_BPS[tranche] // BPS_DENOM


def _source_result(
    state: str,
    tag: str = "",
    commit: str = "",
    ts: int = 0,
    registry: str = "",
    digest: str = "",
) -> dict:
    return {
        "state": state,
        "tag": tag,
        "commit": commit,
        "ts": ts,
        "registry": registry,
        "digest": digest,
    }


def _classify_source(status, body, ctx: dict) -> dict:
    """Turns one mirror response into a per-source result. Total function: it
    never raises, and an unparsable or oversized body is OUTAGE (retryable),
    never a rejection."""
    if not _is_int(status):
        return _source_result(SRC_OUTAGE)
    if status in (404, 410):
        return _source_result(SRC_NOT_FOUND)
    if not (200 <= status < 300):
        return _source_result(SRC_OUTAGE)  # 3xx / 401 / 403 / 408 / 429 / 5xx
    try:
        if body is None:
            return _source_result(SRC_OUTAGE)
        raw = bytes(body) if isinstance(body, (bytes, bytearray)) else str(body).encode("utf-8")
        if len(raw) > MAX_BODY_BYTES:
            return _source_result(SRC_OUTAGE)
        data = json.loads(raw.decode("utf-8"))
    except Exception:
        return _source_result(SRC_OUTAGE)
    if not isinstance(data, dict):
        return _source_result(SRC_OUTAGE)

    failed = _source_result(SRC_FAILED)
    if data.get("schema") != SCHEMA:
        return failed
    if _norm_repo(data.get("repo_url")) != ctx["repo"]:
        return failed  # a record for some other repository is a failure
    mid = data.get("milestone_id")
    if not _is_int(mid) or mid != ctx["milestone_id"]:
        return failed
    found = data.get("found")
    if not isinstance(found, bool):
        return failed
    if not found:
        return failed  # the mirror explicitly reports the tag as missing

    tag = data.get("release_tag")
    if not isinstance(tag, str):
        return failed
    parsed = _parse_semver(tag, ctx["prefix"])
    if parsed is None or not _kind_ok(parsed, ctx["milestone_id"]):
        return failed
    if ctx["prev_tag"]:
        prev = _parse_semver(ctx["prev_tag"], ctx["prefix"])
        if prev is not None and _semver_cmp(parsed, prev) <= 0:
            return failed  # versions must strictly advance tranche to tranche

    commit = data.get("commit_sha")
    if not isinstance(commit, str) or not _is_hex(commit, 40):
        return failed
    if data.get("signature_verified") is not True:
        return failed
    if _canon_hash(data.get("signer_fingerprint_sha256")) != ctx["signer"]:
        return failed  # signed by someone other than the committed key
    ts = data.get("verified_ts")
    if not _is_int(ts) or ts <= 0:
        return failed

    ci = data.get("ci_status")
    if not isinstance(ci, str):
        return failed
    ci = ci.lower()
    if ci in CI_PENDING:
        return _source_result(SRC_NOT_FOUND)  # CI has not finished: mirror lag
    if ci != "success":
        return failed

    art = data.get("artifact")
    if not isinstance(art, dict):
        return failed
    registry = art.get("registry")
    expected = ctx["npm"] if registry == "npm" else ctx["docker"] if registry == "docker" else ""
    if not expected or art.get("name") != expected:
        return failed  # not one of the committed registry targets
    published = art.get("published")
    if not isinstance(published, bool):
        return failed
    if not published:
        return _source_result(SRC_NOT_FOUND)  # registry mirror has not caught up
    digest = art.get("digest")
    if not (isinstance(digest, str) and digest.startswith("sha256:") and _is_hex(digest[7:], 64)):
        return failed
    version = art.get("version")
    if version != tag[len(ctx["prefix"]):]:
        return failed
    # One shipped build earns one tranche: the commit and the artifact digest
    # of an accepted tranche can never satisfy a later one.
    if commit in ctx["used_commits"] or digest in ctx["used_digests"]:
        return failed

    return _source_result(SRC_CONFIRMED, tag, commit, ts, str(registry), digest)


def _aggregate(results: list, milestone_id: int) -> dict:
    """The five-step fault-tolerant quorum. Pure and deterministic.

    1. Tally every source into CONFIRMED / FAILED / NOT_FOUND / OUTAGE.
       FAILED is positive proof: the mirror answered and its record says the
       release is not valid (found=false, unsigned, wrong signer, CI failure,
       wrong artifact ...). NOT_FOUND (404, CI still running, package not yet
       published) and OUTAGE are LAG: they prove nothing either way.
    2. Fewer than 2 sources answered -> QUORUM_FAILURE (retryable).
    3. Two or more CONFIRMED records that agree on the whole release identity
       -- (tag, commit_sha, artifact registry, artifact digest) -> VERIFIED.
    4. Two or more FAILED records -> REJECTED. Only explicit rejections can
       reject; a missing record never does.
    5. Anything else is unproven either way -> QUORUM_FAILURE: a lone
       confirmation beside 404s, a 404 or outage that could still complete a
       quorum, mirrors that disagree. Retryable; nothing about the vault changes.

    Returns {"payload": <the exact five-field verdict>, "commit_sha": str,
    "artifact_digest": str}. The identity travels beside the payload so the
    validators can compare it without widening the five-field verdict.
    """
    confirmed = [r for r in results if r["state"] == SRC_CONFIRMED]
    failed = len([r for r in results if r["state"] == SRC_FAILED])
    missing = len([r for r in results if r["state"] == SRC_NOT_FOUND])
    outage = len([r for r in results if r["state"] == SRC_OUTAGE])
    responded = len(confirmed) + failed + missing

    def wrap(verdict: int, tag: str = "", ts: int = 0, commit: str = "", digest: str = "") -> dict:
        return {
            "payload": {
                "verdict": verdict,
                "milestone_id": milestone_id,
                "source_count": responded,
                "release_tag": tag,
                "verified_ts": ts,
            },
            "commit_sha": commit,
            "artifact_digest": digest,
        }

    # Step 2: not enough witnesses to say anything.
    if responded < QUORUM:
        return wrap(VERDICT_QUORUM_FAILURE)

    # Step 3: corroborated confirmation. Group by the exact release identity.
    groups = {}
    for r in confirmed:
        key = (r["tag"], r["commit"], r["registry"], r["digest"])
        groups.setdefault(key, []).append(r["ts"])
    best_key = ("", "", "", "")
    best_size = 0
    for key in sorted(groups):  # sorted: deterministic tie-break
        if len(groups[key]) > best_size:
            best_key, best_size = key, len(groups[key])
    if best_size >= QUORUM:
        return wrap(VERDICT_VERIFIED, best_key[0], min(groups[best_key]), best_key[1], best_key[3])

    # Step 4: positive proof of failure -- two mirrors explicitly reject.
    if failed >= QUORUM:
        return wrap(VERDICT_REJECTED)

    # Step 5: unproven either way. Lag (404, in-flight CI, unpublished package,
    # outage) and disagreement are retryable, never a rejection.
    return wrap(VERDICT_QUORUM_FAILURE)


def _payload_ok(p, milestone_id: int) -> bool:
    """Exact five-field shape, types, and cross-field consistency."""
    if not isinstance(p, dict) or set(p.keys()) != {
        "verdict", "milestone_id", "source_count", "release_tag", "verified_ts",
    }:
        return False
    v, m, c = p["verdict"], p["milestone_id"], p["source_count"]
    tag, ts = p["release_tag"], p["verified_ts"]
    if not (_is_int(v) and _is_int(m) and _is_int(c) and _is_int(ts)):
        return False
    if not isinstance(tag, str) or v not in (0, 1, 2) or m != milestone_id:
        return False
    if not (0 <= c <= SOURCES) or ts < 0:
        return False
    if v == VERDICT_VERIFIED:
        return tag != "" and ts > 0 and c >= QUORUM
    if tag != "" or ts != 0:
        return False
    if v == VERDICT_QUORUM_FAILURE:
        return True  # retryable at any response count, including all three 404
    return c >= QUORUM  # REJECTED needs two explicit rejections


def _digest_ok(d) -> bool:
    return isinstance(d, str) and d.startswith("sha256:") and _is_hex(d[7:], 64)


def _result_ok(w, milestone_id: int) -> bool:
    """The aggregate's wire shape: the five-field payload, plus a commit and an
    artifact digest that are present exactly when the verdict is VERIFIED."""
    if not isinstance(w, dict) or set(w.keys()) != {"payload", "commit_sha", "artifact_digest"}:
        return False
    if not _payload_ok(w["payload"], milestone_id):
        return False
    commit, digest = w["commit_sha"], w["artifact_digest"]
    if w["payload"]["verdict"] == VERDICT_VERIFIED:
        return isinstance(commit, str) and _is_hex(commit, 40) and _digest_ok(digest)
    return commit == "" and digest == ""


def _results_agree(lead: dict, mine: dict) -> bool:
    """Validator equivalence. Same milestone and verdict; and for VERIFIED the
    same release tag, the same commit_sha and the same artifact digest. A
    validator that independently reached a different commit or digest for the
    same tag disagrees: the tag alone does not identify a release.
    source_count and verified_ts may differ because the two nodes may have
    been served by different 2-of-3 subsets."""
    lp, mp = lead["payload"], mine["payload"]
    if lp["milestone_id"] != mp["milestone_id"]:
        return False
    if lp["verdict"] != mp["verdict"]:
        return False
    if lp["verdict"] == VERDICT_VERIFIED:
        return (
            lp["release_tag"] == mp["release_tag"]
            and lead["commit_sha"] == mine["commit_sha"]
            and lead["artifact_digest"] == mine["artifact_digest"]
        )
    return True


def _fetch_source(url: str, ctx: dict) -> dict:
    """One mirror probe. Network errors are OUTAGE, never an exception."""
    try:
        res = gl.nondet.web.get(url)
    except Exception:
        return _source_result(SRC_OUTAGE)
    status = getattr(res, "status", None)
    if status is None:
        status = getattr(res, "status_code", None)
    return _classify_source(status, getattr(res, "body", None), ctx)


@allow_storage
@dataclass
class Vault:
    funder: Address
    beneficiary: Address
    repo_url: str
    signer_hash: str
    tag_prefix: str
    npm_package: str
    docker_image: str
    feed_a: str
    feed_b: str
    feed_c: str
    deadline: u256
    created_at: u256
    status: str
    deposited: u256
    released: u256
    withdrawn: u256
    reclaimed: u256
    tranches_done: u256
    tag_1: str
    tag_2: str
    tag_3: str
    commit_1: str
    commit_2: str
    commit_3: str
    digest_1: str
    digest_2: str
    digest_3: str
    ts_1: u256
    ts_2: u256
    ts_3: u256
    amt_1: u256
    amt_2: u256
    amt_3: u256
    attempts: u256
    last_verdict: u256
    last_source_count: u256
    last_attempt_at: u256
    last_milestone: u256
    accept_deadline: u256  # the offer lapses (the funder may cancel) after this
    accepted_at: u256  # 0 until the beneficiary accepts


class ShipOrSlash(gl.contract.Contract):
    vaults: TreeMap[u256, Vault]
    next_vault_id: u256
    total_escrow: u256  # deposited - withdrawn - reclaimed, across all vaults
    total_released: u256
    total_slashed: u256
    total_cancelled: u256  # principal returned by cancel_vault

    def __init__(self):
        self.next_vault_id = 1
        self.total_escrow = 0
        self.total_released = 0
        self.total_slashed = 0
        self.total_cancelled = 0

    # ------------------------------------------------------------ internals
    def _now(self) -> int:
        # Integer-only block clock: timedelta.days / .seconds are ints, so no
        # float is ever produced (datetime.timestamp() would return one).
        delta = datetime.now(timezone.utc) - datetime(1970, 1, 1, tzinfo=timezone.utc)
        return delta.days * 86400 + delta.seconds

    def _vault(self, vault_id: u256) -> Vault:
        if vault_id not in self.vaults:
            raise gl.vm.UserError(f"{ERR_STATE} unknown vault")
        return self.vaults[vault_id]

    def _tag(self, v: Vault, k: int) -> str:
        return v.tag_1 if k == 1 else v.tag_2 if k == 2 else v.tag_3 if k == 3 else ""

    def _tranche_view(self, v: Vault, k: int) -> dict:
        done = int(v.tranches_done)
        deposited = int(v.deposited)
        if k <= done:
            status = "ACCEPTED"
            amount = int(v.amt_1 if k == 1 else v.amt_2 if k == 2 else v.amt_3)
            tag = v.tag_1 if k == 1 else v.tag_2 if k == 2 else v.tag_3
            ts = int(v.ts_1 if k == 1 else v.ts_2 if k == 2 else v.ts_3)
            commit = v.commit_1 if k == 1 else v.commit_2 if k == 2 else v.commit_3
            digest = v.digest_1 if k == 1 else v.digest_2 if k == 2 else v.digest_3
        else:
            if v.status == ST_SLASHED:
                status = "SLASHED"
            elif v.status == ST_REJECTED or v.status == ST_CANCELLED:
                status = "CANCELLED"
            elif v.status == ST_PENDING:
                status = "LOCKED"  # nothing is claimable until the offer is accepted
            else:
                status = "PENDING" if k == done + 1 else "LOCKED"
            if k == done + 1:
                # Exactly what claim_milestone will pay: the cumulative
                # entitlement at the CURRENT deposit, less what is already
                # released. After a top-up this is larger than the
                # tranche's nominal share, and the view must say so.
                amount = _cum_entitlement(deposited, k) - int(v.released)
            else:
                amount = _cum_entitlement(deposited, k) - _cum_entitlement(deposited, k - 1)
            tag, ts, commit, digest = "", 0, "", ""
        return {
            "milestone_id": k,
            "kind": TRANCHE_KIND[k],
            "bps": TRANCHE_BPS[k - 1],
            "status": status,
            "release_tag": tag,
            "commit_sha": commit,
            "artifact_digest": digest,
            "verified_ts": ts,
            "amount": str(amount),
        }

    def _feeds(self, v: Vault) -> list:
        return [v.feed_a, v.feed_b, v.feed_c]

    # ---------------------------------------------------------------- views
    @gl.public.view
    def whoami(self) -> str:
        return gl.message.sender_address.as_hex

    @gl.public.view
    def get_constants(self) -> dict:
        return {
            "tranche_bps": list(TRANCHE_BPS),
            "cumulative_bps": list(CUM_BPS[1:]),
            "bps_denominator": BPS_DENOM,
            "tranche_kinds": list(TRANCHE_KIND[1:]),
            "quorum": QUORUM,
            "sources": SOURCES,
            "schema": SCHEMA,
            "min_deposit": str(MIN_DEPOSIT),
            "acceptance_window": ACCEPTANCE_WINDOW,
            "min_window": MIN_WINDOW,
            "min_deadline_window": MIN_DEADLINE_WINDOW,
            "max_window": MAX_WINDOW,
        }

    @gl.public.view
    def get_protocol_state(self) -> dict:
        return {
            "vault_count": int(self.next_vault_id) - 1,
            "next_vault_id": int(self.next_vault_id),
            "total_escrow": str(self.total_escrow),
            "total_released": str(self.total_released),
            "total_slashed": str(self.total_slashed),
            "total_cancelled": str(self.total_cancelled),
            "contract_balance": str(self.balance),
            "solvent": self.balance >= self.total_escrow,
        }

    @gl.public.view
    def get_vault_state(self, vault_id: u256) -> dict:
        v = self._vault(vault_id)
        deposited, released = int(v.deposited), int(v.released)
        return {
            "vault_id": int(vault_id),
            "status": v.status,
            "funder": v.funder.as_hex,
            "beneficiary": v.beneficiary.as_hex,
            "repo_url": v.repo_url,
            "signer_hash": v.signer_hash,
            "tag_prefix": v.tag_prefix,
            "npm_package": v.npm_package,
            "docker_image": v.docker_image,
            "feeds": self._feeds(v),
            "deadline": int(v.deadline),
            "created_at": int(v.created_at),
            "accept_deadline": int(v.accept_deadline),
            "accepted_at": int(v.accepted_at),
            "deposited": str(deposited),
            "released": str(released),
            "withdrawn": str(int(v.withdrawn)),
            "reclaimed": str(int(v.reclaimed)),
            "withdrawable": str(released - int(v.withdrawn)),
            "unreleased": str(deposited - released - int(v.reclaimed)),
            "tranches_done": int(v.tranches_done),
            "attempts": int(v.attempts),
            "last_verdict": int(v.last_verdict),
            "last_source_count": int(v.last_source_count),
            "last_attempt_at": int(v.last_attempt_at),
            "last_milestone": int(v.last_milestone),
            "tranches": [self._tranche_view(v, k) for k in (1, 2, 3)],
        }

    @gl.public.view
    def get_milestone_status(self, vault_id: u256, milestone_id: u256) -> dict:
        v = self._vault(vault_id)
        k = int(milestone_id)
        if k < 1 or k > TRANCHES:
            raise gl.vm.UserError(f"{ERR_PARAMS} milestone_id must be 1..3")
        out = self._tranche_view(v, k)
        out["vault_id"] = int(vault_id)
        out["source_urls"] = [f"{u}milestone_{k}.json" for u in self._feeds(v)]
        out["previous_tag"] = self._tag(v, k - 1) if k > 1 else ""
        out["claimable_now"] = (
            v.status == ST_ACTIVE and int(v.tranches_done) == k - 1
        )
        return out

    @gl.public.view
    def get_verifier_sources(self, vault_id: u256) -> dict:
        v = self._vault(vault_id)
        roles = (
            "GitHub release + signed-commit verifier",
            "Independent CI/CD status mirror",
            "Package artifact / registry mirror",
        )
        rows = []
        hosts = []
        operators = []
        for i, url in enumerate(self._feeds(v)):
            host = _feed_host(url)
            op = _operator(host)
            hosts.append(host)
            operators.append(op)
            rows.append(
                {"slot": SLOTS[i], "role": roles[i], "base_url": url, "host": host, "operator": op}
            )
        return {
            "vault_id": int(vault_id),
            "sources": rows,
            "distinct_hosts": len(set(hosts)),
            "distinct_operators": len(set(operators)),
            "independent": len(set(hosts)) == SOURCES and len(set(operators)) == SOURCES,
            "quorum": QUORUM,
            "repo_url": v.repo_url,
            "signer_hash": v.signer_hash,
            "npm_package": v.npm_package,
            "docker_image": v.docker_image,
        }

    @gl.public.view
    def preview_release(self, vault_id: u256, milestone_id: u256) -> str:
        """The amount milestone `milestone_id` would credit if accepted now."""
        v = self._vault(vault_id)
        k = int(milestone_id)
        if k < 1 or k > TRANCHES:
            raise gl.vm.UserError(f"{ERR_PARAMS} milestone_id must be 1..3")
        return str(_cum_entitlement(int(v.deposited), k) - int(v.released))

    # --------------------------------------------------------------- writes
    @gl.public.write.payable
    def create_vault(
        self,
        beneficiary_hex: str,
        repo_url: str,
        signer_fp_hash: str,
        tag_prefix: str,
        npm_package: str,
        docker_image: str,
        feed_a: str,
        feed_b: str,
        feed_c: str,
        deadline: u256,
    ) -> u256:
        """Escrows msg.value and commits the immutable repository registry.
        Nothing about the registry or the verifier feeds can change afterwards:
        the contract exposes no setter."""
        value = int(gl.message.value)
        if value < MIN_DEPOSIT:
            raise gl.vm.UserError(f"{ERR_DEPOSIT} minimum is {MIN_DEPOSIT} atto")
        # Share floors: every tranche must be strictly positive.
        for k in (1, 2, 3):
            if _cum_entitlement(value, k) - _cum_entitlement(value, k - 1) <= 0:
                raise gl.vm.UserError(f"{ERR_DEPOSIT} tranche rounds to zero")

        try:
            beneficiary = Address(beneficiary_hex)
        except Exception:
            raise gl.vm.UserError(f"{ERR_PARAMS} invalid beneficiary address")
        if beneficiary_hex.lower() == GENESIS_ZERO:
            raise gl.vm.UserError(f"{ERR_PARAMS} beneficiary cannot be the zero address")
        if beneficiary == gl.message.sender_address:
            raise gl.vm.UserError(f"{ERR_PARAMS} funder and beneficiary must differ")

        repo = _norm_repo(repo_url)
        if repo == "":
            raise gl.vm.UserError(f"{ERR_REGISTRY} repo_url must be https://github.com|gitlab.com/<owner>/<repo>")
        signer = _canon_hash(signer_fp_hash)
        if signer == "":
            raise gl.vm.UserError(f"{ERR_REGISTRY} signer_fp_hash must be a sha256 hex digest")
        if tag_prefix not in ("", "v"):
            raise gl.vm.UserError(f"{ERR_REGISTRY} tag_prefix must be '' or 'v'")
        for name in (npm_package, docker_image):
            if name != "" and not _printable(name, MAX_NAME_LEN):
                raise gl.vm.UserError(f"{ERR_REGISTRY} invalid artifact target")
            if name != "" and any(c in name for c in ' "\\<>'):
                raise gl.vm.UserError(f"{ERR_REGISTRY} invalid artifact target")
        if npm_package == "" and docker_image == "":
            raise gl.vm.UserError(f"{ERR_REGISTRY} at least one artifact registry target is required")

        hosts = []
        operators = []
        for url in (feed_a, feed_b, feed_c):
            host = _feed_host(url)
            if host == "":
                raise gl.vm.UserError(f"{ERR_FEEDS} unsafe or malformed verifier URL")
            hosts.append(host)
            operators.append(_operator(host))
        if len(set(hosts)) != SOURCES:
            raise gl.vm.UserError(f"{ERR_FEEDS} verifier hosts must be three distinct hostnames")
        if len(set(operators)) != SOURCES:
            raise gl.vm.UserError(f"{ERR_FEEDS} verifier operators must be three distinct operators")

        now = self._now()
        if int(deadline) < now + MIN_DEADLINE_WINDOW or int(deadline) > now + MAX_WINDOW:
            raise gl.vm.UserError(f"{ERR_PARAMS} deadline outside the allowed window")

        vault_id = self.next_vault_id
        self.next_vault_id = vault_id + 1
        self.vaults[vault_id] = Vault(
            funder=gl.message.sender_address,
            beneficiary=beneficiary,
            repo_url=repo,
            signer_hash=signer,
            tag_prefix=tag_prefix,
            npm_package=npm_package,
            docker_image=docker_image,
            feed_a=feed_a,
            feed_b=feed_b,
            feed_c=feed_c,
            deadline=int(deadline),
            created_at=now,
            status=ST_PENDING,
            deposited=value,
            released=0,
            withdrawn=0,
            reclaimed=0,
            tranches_done=0,
            tag_1="", tag_2="", tag_3="",
            commit_1="", commit_2="", commit_3="",
            digest_1="", digest_2="", digest_3="",
            ts_1=0, ts_2=0, ts_3=0,
            amt_1=0, amt_2=0, amt_3=0,
            attempts=0,
            last_verdict=0,
            last_source_count=0,
            last_attempt_at=0,
            last_milestone=0,
            accept_deadline=now + ACCEPTANCE_WINDOW,
            accepted_at=0,
        )
        self.total_escrow += value
        return vault_id

    @gl.public.write
    def accept_vault_terms(self, vault_id: u256) -> None:
        """The beneficiary's explicit acceptance. The funder chose the verifier
        mirrors, so until this call the vault is only an offer: no tranche can be
        claimed and the funder cannot change anything, but the funder can cancel
        once the window lapses. Inspect the repository, signer, package targets
        and all three mirrors BEFORE calling this; after it, the registry is
        binding on both sides."""
        v = self._vault(vault_id)
        if gl.message.sender_address != v.beneficiary:
            raise gl.vm.UserError(f"{ERR_UNAUTHORIZED} only the beneficiary may accept")
        if v.status != ST_PENDING:
            raise gl.vm.UserError(f"{ERR_STATE} vault is {v.status}")
        now = self._now()
        if now > int(v.accept_deadline):
            raise gl.vm.UserError(f"{ERR_WINDOW} the acceptance window has closed")
        v.status = ST_ACTIVE
        v.accepted_at = now
        self.vaults[vault_id] = v

    @gl.public.write
    def reject_vault_terms(self, vault_id: u256) -> None:
        """The beneficiary declines the offer. The funder can then cancel at once
        and recover the whole principal."""
        v = self._vault(vault_id)
        if gl.message.sender_address != v.beneficiary:
            raise gl.vm.UserError(f"{ERR_UNAUTHORIZED} only the beneficiary may reject")
        if v.status != ST_PENDING:
            raise gl.vm.UserError(f"{ERR_STATE} vault is {v.status}")
        v.status = ST_REJECTED
        self.vaults[vault_id] = v

    @gl.public.write
    def cancel_vault(self, vault_id: u256) -> str:
        """The funder recovers 100% of the principal, with no penalty, when the
        beneficiary rejected the offer or the acceptance window lapsed without
        acceptance. The funder cannot withdraw the offer while the window is
        still open: the beneficiary is owed the full time to inspect it."""
        v = self._vault(vault_id)
        if gl.message.sender_address != v.funder:
            raise gl.vm.UserError(f"{ERR_UNAUTHORIZED} only the funder may cancel")
        prior = v.status
        lapsed = prior == ST_PENDING and self._now() > int(v.accept_deadline)
        if prior != ST_REJECTED and not lapsed:
            if prior == ST_PENDING:
                raise gl.vm.UserError(f"{ERR_WINDOW} the acceptance window is still open")
            raise gl.vm.UserError(f"{ERR_STATE} vault is {prior}")
        amount = int(v.deposited) - int(v.reclaimed)
        if amount <= 0:
            raise gl.vm.UserError(f"{ERR_NO_BALANCE}")
        v.reclaimed = amount
        v.status = ST_CANCELLED
        self.vaults[vault_id] = v
        self.total_escrow -= amount
        self.total_cancelled += amount
        try:
            gl.chain.Account(v.funder).emit_transfer(amount, on="finalized")
        except Exception:
            v.reclaimed = 0
            v.status = prior
            self.vaults[vault_id] = v
            self.total_escrow += amount
            self.total_cancelled -= amount
            raise gl.vm.UserError(f"{ERR_TRANSFER}")
        return str(amount)

    @gl.public.write.payable
    def top_up_vault(self, vault_id: u256) -> None:
        """Funder-only liquidity top-up. Folds into tranches not yet accepted;
        an already-accepted tranche is never re-priced."""
        v = self._vault(vault_id)
        if gl.message.sender_address != v.funder:
            raise gl.vm.UserError(f"{ERR_UNAUTHORIZED} only the funder may top up")
        if v.status != ST_ACTIVE:
            raise gl.vm.UserError(f"{ERR_STATE} vault is not active")
        value = int(gl.message.value)
        if value < MIN_DEPOSIT:
            raise gl.vm.UserError(f"{ERR_DEPOSIT} minimum top-up is {MIN_DEPOSIT} atto")
        v.deposited += value
        self.vaults[vault_id] = v
        self.total_escrow += value

    @gl.public.write
    def claim_milestone(self, vault_id: u256, milestone_id: u256) -> dict:
        """Runs the 2-of-3 verifier quorum for the vault's next tranche and, on
        VERIFIED, releases it. REJECTED and QUORUM_FAILURE change nothing but an
        informational attempt record -- an outage never costs anyone anything."""
        v = self._vault(vault_id)
        sender = gl.message.sender_address
        if sender != v.beneficiary and sender != v.funder:
            raise gl.vm.UserError(f"{ERR_UNAUTHORIZED} only the funder or beneficiary may claim")
        if v.status != ST_ACTIVE:
            raise gl.vm.UserError(f"{ERR_STATE} vault is {v.status}")
        k = int(milestone_id)
        if k < 1 or k > TRANCHES:
            raise gl.vm.UserError(f"{ERR_PARAMS} milestone_id must be 1..3")
        if k != int(v.tranches_done) + 1:
            raise gl.vm.UserError(f"{ERR_SEQUENCE} next claimable milestone is {int(v.tranches_done) + 1}")

        ctx = {
            "repo": v.repo_url,
            "signer": v.signer_hash,
            "prefix": v.tag_prefix,
            "npm": v.npm_package,
            "docker": v.docker_image,
            "milestone_id": k,
            "prev_tag": self._tag(v, k - 1) if k > 1 else "",
            # Builds that already earned an earlier tranche cannot earn this one.
            "used_commits": [c for c in (v.commit_1, v.commit_2, v.commit_3)[: k - 1] if c != ""],
            "used_digests": [d for d in (v.digest_1, v.digest_2, v.digest_3)[: k - 1] if d != ""],
        }
        urls = [f"{base}milestone_{k}.json" for base in self._feeds(v)]

        # Closures capture only plain locals; nothing here touches storage.
        def leader() -> dict:
            return _aggregate([_fetch_source(u, ctx) for u in urls], k)

        def validator(leaders_res) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return False  # leaders never raise; an error is disagreement
            lead = leaders_res.calldata
            if not _result_ok(lead, k):
                return False
            mine = leader()
            return _results_agree(lead, mine)

        outcome = gl.vm.run_nondet(leader, validator)
        if not _result_ok(outcome, k):
            raise gl.vm.UserError(f"{ERR_PAYLOAD} verifier payload failed validation")
        payload = outcome["payload"]

        verdict = int(payload["verdict"])
        v.attempts += 1
        v.last_verdict = verdict
        v.last_source_count = int(payload["source_count"])
        v.last_attempt_at = self._now()
        v.last_milestone = k

        result = dict(payload)
        result["vault_id"] = int(vault_id)
        result["released"] = "0"
        result["accepted"] = False
        result["commit_sha"] = ""
        result["artifact_digest"] = ""

        if verdict == VERDICT_VERIFIED:
            amount = _cum_entitlement(int(v.deposited), k) - int(v.released)
            tag = payload["release_tag"]
            commit = outcome["commit_sha"]
            digest = outcome["artifact_digest"]
            ts = int(payload["verified_ts"])
            # The accepted release identity is the on-chain record: tag, the
            # commit it points at, and the artifact digest, all of which the
            # validators agreed on. They are pinned here and checked against
            # every later tranche (see used_commits / used_digests).
            if k == 1:
                v.tag_1, v.commit_1, v.digest_1, v.ts_1, v.amt_1 = tag, commit, digest, ts, amount
            elif k == 2:
                v.tag_2, v.commit_2, v.digest_2, v.ts_2, v.amt_2 = tag, commit, digest, ts, amount
            else:
                v.tag_3, v.commit_3, v.digest_3, v.ts_3, v.amt_3 = tag, commit, digest, ts, amount
            v.released += amount
            v.tranches_done = k
            if k == TRANCHES:
                v.status = ST_COMPLETE
            self.total_released += amount
            result["released"] = str(amount)
            result["accepted"] = True
            result["commit_sha"] = commit
            result["artifact_digest"] = digest

        self.vaults[vault_id] = v
        return result

    @gl.public.write
    def withdraw_released(self, vault_id: u256) -> str:
        """Pull payment. The beneficiary withdraws everything released and not
        yet withdrawn. Checks-Effects-Interactions: the debit lands first and is
        restored if the transfer cannot be queued."""
        v = self._vault(vault_id)
        if gl.message.sender_address != v.beneficiary:
            raise gl.vm.UserError(f"{ERR_UNAUTHORIZED} only the beneficiary may withdraw")
        amount = int(v.released) - int(v.withdrawn)
        if amount <= 0:
            raise gl.vm.UserError(f"{ERR_NO_BALANCE}")
        v.withdrawn = v.released
        self.vaults[vault_id] = v
        self.total_escrow -= amount
        try:
            gl.chain.Account(v.beneficiary).emit_transfer(amount, on="finalized")
        except Exception:
            v.withdrawn -= amount
            self.vaults[vault_id] = v
            self.total_escrow += amount
            raise gl.vm.UserError(f"{ERR_TRANSFER}")
        return str(amount)

    @gl.public.write
    def reclaim_unreleased(self, vault_id: u256) -> str:
        """The slash. After the deadline the funder recovers every tranche that
        was not shipped. Released tranches stay withdrawable by the beneficiary.
        Closes the vault."""
        v = self._vault(vault_id)
        if gl.message.sender_address != v.funder:
            raise gl.vm.UserError(f"{ERR_UNAUTHORIZED} only the funder may reclaim")
        if v.status != ST_ACTIVE:
            raise gl.vm.UserError(f"{ERR_STATE} vault is {v.status}")
        if self._now() < int(v.deadline):
            raise gl.vm.UserError(f"{ERR_NOT_EXPIRED}")
        amount = int(v.deposited) - int(v.released) - int(v.reclaimed)
        if amount <= 0:
            raise gl.vm.UserError(f"{ERR_NO_BALANCE}")
        v.reclaimed = amount
        v.status = ST_SLASHED
        self.vaults[vault_id] = v
        self.total_escrow -= amount
        self.total_slashed += amount
        try:
            gl.chain.Account(v.funder).emit_transfer(amount, on="finalized")
        except Exception:
            v.reclaimed = 0
            v.status = ST_ACTIVE
            self.vaults[vault_id] = v
            self.total_escrow += amount
            self.total_slashed -= amount
            raise gl.vm.UserError(f"{ERR_TRANSFER}")
        return str(amount)
