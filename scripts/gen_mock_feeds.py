#!/usr/bin/env python3
"""Generates the commit-pinned mock milestone fixtures under
deployments/mock_feeds/{a,b,c}/milestone_{1,2,3}.json.

These are DEMONSTRATION fixtures, not real releases: the repository, tags,
commits, signer and package digests below are synthetic. They exist so the
contract's three verifier slots have stable, commit-pinned documents to read on
three independent hosts. Each record carries "mock": true; the contract ignores
unknown fields.

    python3 scripts/gen_mock_feeds.py
"""

import hashlib
import json
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "deployments", "mock_feeds")
REPO = "https://github.com/SOBEK96/ShipOrSlash"
FINGERPRINT = "3AA5 C34371567BD2 5FA4E14A9D8C1B7E00F26A41"  # synthetic, not a real key
SIGNER_HASH = hashlib.sha256(FINGERPRINT.replace(" ", "").upper().encode()).hexdigest()
NPM = "@sobek96/shiporslash"
DOCKER = "sobek96/shiporslash"
BASE_TS = 1760000000

MILESTONES = {
    1: ("v0.1.0-alpha.1", "1a" * 20),
    2: ("v0.9.0-rc.1", "2b" * 20),
    3: ("v1.0.0", "3c" * 20),
}
# slot -> (role, artifact registry the slot reports, timestamp skew in seconds)
SLOTS = {
    "a": ("github-release-verifier", "npm", 0),
    "b": ("ci-status-mirror", "npm", 7),
    "c": ("package-registry-mirror", "docker", 13),
}


def record(slot: str, milestone: int) -> dict:
    tag, commit = MILESTONES[milestone]
    role, registry, skew = SLOTS[slot]
    return {
        "schema": "shiporslash/v1",
        "mock": True,
        "slot": slot.upper(),
        "role": role,
        "repo_url": REPO,
        "milestone_id": milestone,
        "found": True,
        "release_tag": tag,
        "commit_sha": commit,
        "signature_verified": True,
        "signer_fingerprint_sha256": SIGNER_HASH,
        "ci_status": "success",
        "artifact": {
            "registry": registry,
            "name": NPM if registry == "npm" else DOCKER,
            "version": tag[1:],
            "published": True,
            "digest": "sha256:" + hashlib.sha256(f"{registry}:{tag}".encode()).hexdigest(),
        },
        "verified_ts": BASE_TS + milestone * 86400 + skew,
    }


def main() -> None:
    for slot in SLOTS:
        d = os.path.join(ROOT, slot)
        os.makedirs(d, exist_ok=True)
        for m in MILESTONES:
            path = os.path.join(d, f"milestone_{m}.json")
            with open(path, "w") as f:
                json.dump(record(slot, m), f, indent=2, sort_keys=True)
                f.write("\n")
            print("wrote", os.path.relpath(path))
    print("signer_fingerprint_sha256 =", SIGNER_HASH)


if __name__ == "__main__":
    main()
