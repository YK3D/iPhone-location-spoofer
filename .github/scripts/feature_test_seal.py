"""Encrypt feature-test builds and keep their encrypted index (used by feature-tests.yml).

The password comes from the FEATURE_TEST_PASSWORD environment variable (a repository secret), never
from the command line. Format, read by the app (feature_tests.rs / feature_tests.py):

    b"LSFT1" | iterations (u32, big-endian) | salt (16) | nonce (12) | AES-256-GCM ciphertext + tag

with the key derived by PBKDF2-HMAC-SHA256 from the password and the salt, and b"LSFT1" as the
associated data.

    python feature_test_seal.py seal IN OUT
    python feature_test_seal.py open IN OUT
    python feature_test_seal.py upsert INDEX --pr N --title T --url U --sha S --asset A --sha256 H --size B --version V
    python feature_test_seal.py state INDEX --pr N --state merged|closed     (closed: removed)

INDEX is the encrypted index file; it is created when missing. Needs: pip install cryptography
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import time
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

MAGIC = b"LSFT1"
ITERATIONS = 600_000


def _key(password: str, salt: bytes, iterations: int) -> bytes:
    return PBKDF2HMAC(algorithm=SHA256(), length=32, salt=salt, iterations=iterations).derive(password.encode())


def seal(password: str, plain: bytes, iterations: int = ITERATIONS) -> bytes:
    salt, nonce = os.urandom(16), os.urandom(12)
    ct = AESGCM(_key(password, salt, iterations)).encrypt(nonce, plain, MAGIC)
    return MAGIC + struct.pack(">I", iterations) + salt + nonce + ct


def open_(password: str, data: bytes) -> bytes:
    if len(data) < 53 or data[:5] != MAGIC:
        raise ValueError("not a feature-test file")
    (iterations,) = struct.unpack(">I", data[5:9])
    return AESGCM(_key(password, data[9:25], iterations)).decrypt(data[25:37], data[37:], MAGIC)


def _password() -> str:
    pw = os.environ.get("FEATURE_TEST_PASSWORD", "")
    if not pw:
        sys.exit("FEATURE_TEST_PASSWORD is not set")
    return pw


def _load_index(path: Path, pw: str) -> dict:
    if not path.is_file():
        return {"builds": []}
    return json.loads(open_(pw, path.read_bytes()))


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("seal", "open"):
        p = sub.add_parser(name)
        p.add_argument("src", type=Path)
        p.add_argument("dst", type=Path)
    up = sub.add_parser("upsert")
    up.add_argument("index", type=Path)
    for k in ("pr", "title", "url", "sha", "asset", "sha256", "size", "version"):
        up.add_argument(f"--{k}", required=True)
    st = sub.add_parser("state")
    st.add_argument("index", type=Path)
    st.add_argument("--pr", required=True)
    st.add_argument("--state", choices=("merged", "closed"), required=True)
    a = ap.parse_args()
    pw = _password()
    if a.cmd == "seal":
        a.dst.write_bytes(seal(pw, a.src.read_bytes()))
    elif a.cmd == "open":
        a.dst.write_bytes(open_(pw, a.src.read_bytes()))
    elif a.cmd == "upsert":
        idx = _load_index(a.index, pw)
        if len(a.sha256) != 64 or any(c not in "0123456789abcdef" for c in a.sha256.lower()):
            sys.exit("--sha256 must be the exe's SHA-256 in hex")
        entry = {
            "pr": int(a.pr), "title": a.title[:200], "url": a.url, "sha": a.sha, "asset": a.asset,
            "sha256": a.sha256.lower(), "size": int(a.size), "version": a.version, "state": "open",
            "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        idx["builds"] = [b for b in idx.get("builds", []) if b.get("pr") != entry["pr"]] + [entry]
        idx["builds"].sort(key=lambda b: -int(b["pr"]))
        a.index.write_bytes(seal(pw, json.dumps(idx).encode()))
    else:
        idx = _load_index(a.index, pw)
        pr = int(a.pr)
        if a.state == "closed":
            idx["builds"] = [b for b in idx.get("builds", []) if b.get("pr") != pr]
        else:
            for b in idx.get("builds", []):
                if b.get("pr") == pr:
                    b["state"] = "merged"
        a.index.write_bytes(seal(pw, json.dumps(idx).encode()))


if __name__ == "__main__":
    main()
