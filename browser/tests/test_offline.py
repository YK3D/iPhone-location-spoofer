import asyncio
import json

import httpx
import pytest

from spoofer import offline
from spoofer.offline import Bounds, Offline, area_tile_count, cache_key, tile_count, tile_xy, tiles

CITY = Bounds(51.50, -0.13, 51.51, -0.12)


def test_tile_math_matches_the_standalone_app():
    assert tile_xy(0, 0, 1) == (1, 1)
    assert tile_xy(51.5074, -0.1278, 14) == (8186, 5448)
    assert tile_xy(85.0511, -180, 3) == (0, 0)
    assert tile_xy(-85.0511, 180, 3) == (7, 7)
    b = Bounds(51.49, -0.15, 51.52, -0.1)
    assert tile_count(b, 0, 14) == len(tiles(b, 0, 14))
    assert area_tile_count(b, 0, 18) == tile_count(b, 0, 14) + tile_count(b, 0, 6)
    assert area_tile_count(b, 10, 14) == tile_count(b, 10, 14)


def test_limits():
    with pytest.raises(ValueError):
        Bounds(1, 1, 0.5, 2).validated()
    assert Offline.estimate(Bounds(-80, -179, 80, 179), 0, 14)["ok"] is False
    assert Offline.estimate(Bounds(51.49, -0.15, 51.52, -0.1), 0, 14)["ok"] is True


def test_cache_keys():
    assert cache_key("planet/20261101_080013_pt/14/8186/5448.pbf") == ("planet-tiles/14/8186/5448.pbf", "tile")
    assert cache_key("planet") == ("planet.json", "fresh")
    assert cache_key("styles/dark") == ("styles/dark.json", "fresh")
    assert cache_key("fonts/Noto%20Sans%20Regular/0-255.pbf")[1] == "static"
    assert cache_key("sprites/ofm_f384/ofm@2x.png")[1] == "static"
    assert cache_key("natural_earth/ne2sr/3/4/2.png")[1] == "tile"
    for bad in ["../x", "fonts/../../etc", "/etc/passwd", "styles/a b", "other/x", "fonts//x", "planet/v/1/2"]:
        assert cache_key(bad) is None, bad


STYLE = {
    "sprite": "https://tiles.openfreemap.org/sprites/ofm_f384/ofm",
    "glyphs": "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    "layers": [{"id": "a", "layout": {"text-font": ["Noto Sans Regular"]}}, {"id": "b"}],
}


def fake_ofm(requests: list):
    def handler(req: httpx.Request) -> httpx.Response:
        path = req.url.raw_path.decode().removeprefix("/")
        requests.append(path)
        assert req.headers["user-agent"].startswith("LocationSpoofer/")
        if path == "planet":
            return httpx.Response(200, json={"tiles": ["https://tiles.openfreemap.org/planet/v1/{z}/{x}/{y}.pbf"]})
        if path.startswith("styles/"):
            return httpx.Response(200, json=STYLE)
        return httpx.Response(200, content=b"data:" + path.encode())
    return httpx.MockTransport(handler)


def offline_transport():
    def handler(req):
        raise httpx.ConnectError("offline")
    return httpx.MockTransport(handler)


async def wait_job(off: Offline):
    for _ in range(500):
        if not off.job.running:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("download did not finish")


def test_download_then_use_offline_then_delete(tmp_path):
    async def run():
        seen: list = []
        off = Offline(tmp_path, transport=fake_ofm(seen))
        off.start("Home", CITY, 12, 14)
        await wait_job(off)
        assert off.job.error is None, off.job.error
        expected = area_tile_count(CITY, 12, 14)
        assert off.job.done == expected
        assert "fonts/Noto%20Sans%20Regular/0-255.pbf" in seen and "sprites/ofm_f384/ofm@2x.png" in seen
        (area,) = off.areas()
        assert area["name"] == "Home" and area["tiles"] == expected
        # without internet: tiles, styles and fonts come from the cache
        off._transport = offline_transport()
        z, x, y = tiles(CITY, 14, 14)[0]
        assert await off.proxy(f"planet/v2/{z}/{x}/{y}.pbf") == (200, "application/x-protobuf", f"data:planet/v1/{z}/{x}/{y}.pbf".encode())
        assert (await off.proxy("styles/dark"))[0] == 200
        assert (await off.proxy("fonts/Noto%20Sans%20Regular/0-255.pbf"))[0] == 200
        # an area that wasn't downloaded: empty tiles instead of errors
        assert await off.proxy("planet/v1/3/1/1.pbf") == (200, "application/x-protobuf", b"")
        assert (await off.proxy("natural_earth/ne2sr/0/0/0.png"))[2] == offline.EMPTY_PNG
        assert (await off.proxy("../x"))[0] == 404
        off.delete_area(area["id"])
        assert off.areas() == []
        assert not list((tmp_path / "offline" / "cache" / "planet-tiles").rglob("*.pbf"))
        with pytest.raises(LookupError):
            off.delete_area(area["id"])
    asyncio.run(run())


def test_download_refuses_big_areas_and_cleans_up_failures(tmp_path):
    async def run():
        off = Offline(tmp_path, transport=fake_ofm([]))
        with pytest.raises(ValueError, match="3000"):
            off.start(None, Bounds(-80, -179, 80, 179), 0, 14)
        calls = {"n": 0}

        def flaky(req):
            p = req.url.raw_path.decode().removeprefix("/")
            if p == "planet":
                return httpx.Response(200, json={"tiles": ["https://tiles.openfreemap.org/planet/v1/{z}/{x}/{y}.pbf"]})
            if p.startswith("styles/"):
                return httpx.Response(200, json=STYLE)
            calls["n"] += 1
            return httpx.Response(500) if calls["n"] > 12 else httpx.Response(200, content=b"x")
        off._transport = httpx.MockTransport(flaky)
        off.start(None, CITY, 10, 14)
        await wait_job(off)
        assert "500" in off.job.error
        assert off.areas() == []
        assert not list((tmp_path / "offline" / "cache" / "planet-tiles").rglob("*.pbf"))
    asyncio.run(run())


def test_api(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from spoofer import server
    from spoofer.store import Store

    monkeypatch.setenv("SPOOFER_DATA_DIR", str(tmp_path))
    server.app.state.s = server.AppState()
    server.app.state.s.store = Store(tmp_path / "data.json")
    server.app.state.s.offline._transport = offline_transport()
    (tmp_path / "offline" / "cache" / "styles").mkdir(parents=True)
    (tmp_path / "offline" / "cache" / "styles" / "dark.json").write_text(json.dumps(STYLE))
    with TestClient(server.app, base_url="http://127.0.0.1:8765") as c:
        assert c.get("/api/offline").json()["limits"]["max_tiles"] == 3000
        r = c.post("/api/offline/estimate", json={"bounds": {"south": 51.5, "west": -0.13, "north": 51.51, "east": -0.12}, "max_zoom": 14})
        assert r.json()["ok"] is True
        r = c.post("/api/offline/download", json={"bounds": {"south": -80, "west": -179, "north": 80, "east": 179}, "max_zoom": 14})
        assert r.status_code == 400
        r = c.get("/ofm/styles/dark")
        assert r.status_code == 200 and r.json()["glyphs"].startswith("https://")
        assert c.get("/ofm/fonts/Noto%20Sans%20Regular/0-255.pbf").status_code == 502  # not cached, offline
        assert c.delete("/api/offline/nope").status_code == 404
