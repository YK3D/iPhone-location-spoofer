import asyncio
import hashlib
import json
import sys
from pathlib import Path

import httpx
import pytest

from spoofer.feature_tests import FeatureTestError, FeatureTests, open_sealed, seal

ROOT = Path(__file__).resolve().parents[2]
EXE = b"MZ fake exe"


def test_seal_and_open():
    data = seal("correct horse", b"hello build", 1000)
    assert open_sealed("correct horse", data) == b"hello build"
    with pytest.raises(FeatureTestError, match="Wrong password"):
        open_sealed("wrong", data)
    changed = bytearray(data)
    changed[-1] ^= 1
    with pytest.raises(FeatureTestError):
        open_sealed("correct horse", bytes(changed))


def test_same_format_as_ci_script_and_standalone_app():
    sys.path.insert(0, str(ROOT / ".github" / "scripts"))
    import feature_test_seal as ci

    assert open_sealed("pw", ci.seal("pw", b"x", 1000)) == b"x"
    assert ci.open_("pw", seal("pw", b"y", 1000)) == b"y"
    sample = bytes.fromhex((ROOT / "standalone" / "testdata" / "ft_sample.hex").read_text().strip())
    assert open_sealed("pw", sample) == b'{"builds": []}'


def fake_github(password: str, served: list):
    manifest = {"builds": [{"pr": 14, "title": "New engine", "url": "https://github.com/x/y/pull/14", "asset": "ft-pr14.bin",
                            "sha256": hashlib.sha256(EXE).hexdigest(), "size": len(EXE), "version": "0.2.9-ft14", "state": "open",
                            "built_at": "2026-11-05T10:00:00Z"}]}
    files = {"ft-index.bin": seal(password, json.dumps(manifest).encode(), 1000), "ft-pr14.bin": seal(password, EXE, 1000)}

    def handler(req: httpx.Request) -> httpx.Response:
        name = req.url.path.rsplit("/", 1)[-1]
        assert req.url.path.startswith("/YK3D/iPhone-location-spoofer/releases/download/feature-tests/")
        served.append(name)
        return httpx.Response(200, content=files[name]) if name in files else httpx.Response(404)
    return httpx.MockTransport(handler)


def test_unlock_list_open_and_lock(tmp_path):
    async def run():
        served, launched = [], []
        ft = FeatureTests(tmp_path, "YK3D/iPhone-location-spoofer", launcher=lambda *a: launched.append(a),
                          transport=fake_github("s3cret", served))
        assert await ft.list() == {"locked": True}
        with pytest.raises(FeatureTestError, match="Unlock"):
            await ft.open_build(14)
        with pytest.raises(FeatureTestError, match="Wrong password"):
            await ft.unlock("nope", remember=True)
        assert ft.password is None
        got = await ft.unlock("s3cret", remember=True)
        assert got["locked"] is False and got["builds"][0]["pr"] == 14 and "asset" not in got["builds"][0]
        assert (tmp_path / "feature-tests" / "access.key").read_text() == "s3cret"
        # a new start remembers the password
        ft = FeatureTests(tmp_path, "YK3D/iPhone-location-spoofer", launcher=lambda *a: launched.append(a),
                          transport=fake_github("s3cret", served))
        assert (await ft.list())["builds"][0]["title"] == "New engine"
        await ft.open_build(14)
        exe, args, data = launched[-1]
        assert exe.read_bytes() == EXE and args == ["--port", "0", "--no-update", "--feature-test", "14"]
        assert data == tmp_path / "feature-tests" / "data"
        served.clear()
        await ft.open_build(14)  # already downloaded: only the index is fetched
        assert served == ["ft-index.bin"]
        with pytest.raises(FeatureTestError, match="no build"):
            await ft.open_build(99)
        ft.lock()
        assert await ft.list() == {"locked": True} and not (tmp_path / "feature-tests" / "access.key").exists()
    asyncio.run(run())


def test_not_published_yet(tmp_path):
    async def run():
        ft = FeatureTests(tmp_path, "YK3D/iPhone-location-spoofer", launcher=lambda *a: None,
                          transport=httpx.MockTransport(lambda r: httpx.Response(404)))
        with pytest.raises(FeatureTestError) as e:
            await ft.unlock("x", remember=False)
        assert e.value.status == 404
    asyncio.run(run())
