import asyncio
import hashlib
import json

import httpx
import pytest

from spoofer import updater as up

NEW_EXE = b"MZ new exe bytes " * 1000
DIGEST = hashlib.sha256(NEW_EXE).hexdigest()


def fake_github(tag="v1.1.50", digest=DIGEST, exe_host="release-assets.githubusercontent.com", body=NEW_EXE):
    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if url.endswith("/releases/latest"):
            return httpx.Response(200, json={
                "tag_name": tag,
                "body": "notes",
                "assets": [
                    {"name": "LocationSpoofer.exe", "browser_download_url": "https://github.com/o/r/releases/download/x/LocationSpoofer.exe"},
                    {"name": "LocationSpoofer.exe.sha256", "browser_download_url": "https://github.com/o/r/releases/download/x/LocationSpoofer.exe.sha256"},
                ],
            })
        if url.endswith("LocationSpoofer.exe.sha256"):
            return httpx.Response(200, text=f"{digest}  LocationSpoofer.exe")
        if url.endswith("download/x/LocationSpoofer.exe"):
            return httpx.Response(302, headers={"Location": f"https://{exe_host}/blob/exe"})
        if url.endswith("/blob/exe"):
            return httpx.Response(200, content=body)
        return httpx.Response(404)

    return httpx.MockTransport(handler)


def make(tmp_path, current="1.1.10", transport=None):
    exe = tmp_path / "LocationSpoofer.exe"
    exe.write_bytes(b"MZ old exe")
    return up.Updater(exe_path=exe, current=current, enabled=True, transport=transport)


@pytest.mark.parametrize("a,b,newer", [
    ("v1.1.50", "1.1.10", True), ("1.1.9", "1.1.10", False), ("1.2", "1.1.99", True),
    ("1.1.10", "1.1.10", False), ("v1.1.1", "1.1.0-dev", True), ("garbage", "1.0.0", False),
])
def test_is_newer(a, b, newer):
    assert up.is_newer(a, b) is newer


def test_download_verify_and_swap(tmp_path, monkeypatch):
    u = make(tmp_path, transport=fake_github())
    st = asyncio.run(u.check())
    assert st["state"] == "ready", st
    assert u.staged_version() == "1.1.50"
    assert u.swap_in_staged()
    assert u.exe.read_bytes() == NEW_EXE
    assert u.old.read_bytes() == b"MZ old exe"
    assert not u.staged.exists() and not u.staged_meta.exists()

    launched = []
    monkeypatch.setattr(up.subprocess, "Popen", lambda cmd, **kw: launched.append(cmd))
    u.relaunch(["--port", "9000", "--wait-pid", "123", "--no-browser"])
    cmd = launched[0]
    assert cmd[0] == str(u.exe) and "123" not in cmd
    assert cmd[1:4] == ["--port", "9000", "--no-browser"] and cmd[-2] == "--wait-pid"

    u.cleanup_old(wait_s=1)
    assert not u.old.exists()


def test_bad_checksum_discarded(tmp_path):
    u = make(tmp_path, transport=fake_github(digest="0" * 64))
    st = asyncio.run(u.check())
    assert st["state"] == "error" and "SHA-256" in st["error"]
    assert u.staged_version() is None and not u.staged.exists()
    assert not u.swap_in_staged()
    assert u.exe.read_bytes() == b"MZ old exe"


def test_untrusted_host_refused(tmp_path):
    u = make(tmp_path, transport=fake_github(exe_host="evil.example.com"))
    st = asyncio.run(u.check())
    assert st["state"] == "error" and "evil.example.com" in st["error"]
    assert not u.staged.exists()


def test_up_to_date_and_no_release(tmp_path):
    u = make(tmp_path, current="1.1.50", transport=fake_github())
    assert asyncio.run(u.check())["state"] == "up_to_date"
    none = httpx.MockTransport(lambda r: httpx.Response(404))
    u2 = make(tmp_path, transport=none)
    assert asyncio.run(u2.check())["state"] == "up_to_date"


def test_tampered_staged_file_ignored(tmp_path):
    u = make(tmp_path, transport=fake_github())
    asyncio.run(u.check())
    u.staged.write_bytes(b"tampered")
    assert u.staged_version() is None
    assert not u.swap_in_staged()


def test_disabled_from_source(tmp_path):
    u = up.Updater(exe_path=tmp_path / "x.exe", enabled=False)
    assert asyncio.run(u.check())["state"] == "disabled"
