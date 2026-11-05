"""Hold-until-Continue checkpoints, lap limits, the smoothed heading and the Simulator's iOS version."""

import asyncio
import time

import pytest
from fastapi.testclient import TestClient

from spoofer import geo
from spoofer.device.mock import MockDriver
from spoofer.player import Player
from spoofer.profile import Leg, ProfileSettings, Waypoint, build_timeline

A = (51.5, -0.12)
B = geo.destination(A, 90, 200)
C = geo.destination(B, 0, 200)
FAST = ProfileSettings(default_cruise_kmh=36, accel_ms2=2, decel_ms2=2)


def _timeline(hold_at=None, **kw):
    wps = [Waypoint(*A), Waypoint(*B, hold=hold_at == 1, **kw), Waypoint(*C, hold=hold_at == 2)]
    return build_timeline(wps, [Leg([A, B]), Leg([B, C])], FAST)


def test_hold_checkpoint_stops_there():
    tl = _timeline(hold_at=1)
    assert [i for _, i in tl.holds] == [1]
    h = tl.holds[0][0]
    assert h == pytest.approx(tl.waypoint_times[1])
    p = tl.at(h)
    assert p.speed_ms == pytest.approx(0, abs=1e-6)
    assert geo.haversine_m((p.lat, p.lon), B) < 0.05
    assert tl.next_hold(0) == tl.holds[0] and tl.next_hold(h) is None and tl.next_hold(h + 1, -1) == tl.holds[0]
    assert tl.summary()["holds"] == 1
    # a hold with a wait: the wait runs after the hold
    tl2 = _timeline(hold_at=1, dwell_s=10)
    assert tl2.holds[0][0] == pytest.approx(tl2.waypoint_times[1])
    assert tl2.at(tl2.holds[0][0] + 5).speed_ms == 0


def test_heading_turns_smoothly_through_a_corner():
    tl = _timeline()
    t_b = tl.waypoint_times[1]
    p = tl.at(t_b)
    assert p.speed_ms > 5  # passes the unpinned corner moving
    assert 20 < p.course < 70  # halfway through the turn, not 90 or 0
    assert tl.at(t_b * 0.5).course == pytest.approx(90, abs=0.5)
    assert tl.at((t_b + tl.duration) / 2).course == pytest.approx(0, abs=0.5)
    # changes in small steps: no tick jumps by the whole 90 degrees
    courses = [tl.at(t_b + dt).course for dt in (-1.0, -0.5, 0.0, 0.5, 1.0)]
    diffs = [abs((b - a + 540) % 360 - 180) for a, b in zip(courses, courses[1:])]
    assert max(diffs) < 60 and sum(diffs) == pytest.approx(90, abs=3)


def test_stopped_device_faces_the_way_it_arrived():
    tl = _timeline(hold_at=1)
    p = tl.at(tl.holds[0][0])
    assert p.speed_ms == 0 and p.course == pytest.approx(90, abs=1)
    assert tl.at(0).course == pytest.approx(90, abs=0.5)  # at the start: the way it leaves


async def _wait(cond, timeout=8.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        await asyncio.sleep(0.02)
    return False


def _player(tl):
    drv = MockDriver()
    p = Player(lambda: drv)
    return p, drv


def test_player_waits_at_a_hold_until_continue():
    async def run():
        tl = _timeline(hold_at=1)
        p, drv = _player(tl)
        await drv.connect()
        await p.load(tl, "hold")
        await p.set_options(multiplier=100, tick_s=0.2)
        await p.play()
        assert await _wait(lambda: p.state == "held")
        st = p.status()
        assert st["held_at"] == 1 and st["t"] == pytest.approx(tl.holds[0][0], abs=0.01)
        assert geo.haversine_m(drv.location, B) < 0.05  # stopped exactly on the checkpoint
        sent = len(drv.history)
        await asyncio.sleep(0.6)
        assert p.state == "held" and len(drv.history) == sent  # nothing moves while held
        await p.continue_()
        assert p.state == "playing"
        assert await _wait(lambda: p.state == "finished")
        assert geo.haversine_m(drv.location, C) < 0.05
        await p.stop()

    asyncio.run(run())


def test_lap_limit_stops_a_loop():
    async def run():
        tl = _timeline()
        p, drv = _player(tl)
        await drv.connect()
        await p.load(tl, "laps")
        await p.set_options(multiplier=100, tick_s=0.2, loop="loop", lap_limit=2)
        await p.play()
        assert await _wait(lambda: p.state == "finished", timeout=10)
        assert p.laps == 2
        assert p.status()["lap_limit"] == 2
        # back and forth: a lap is there and back
        await p.set_options(loop="pingpong", lap_limit=1)
        await p.play()
        assert await _wait(lambda: p.state == "finished", timeout=10)
        assert p.laps == 2 and geo.haversine_m(drv.location, A) < 0.05
        with pytest.raises(ValueError):
            await p.set_options(lap_limit=-1)

    asyncio.run(run())


def test_seeking_away_releases_a_hold():
    async def run():
        tl = _timeline(hold_at=1)
        p, drv = _player(tl)
        await drv.connect()
        await p.load(tl, "seek")
        await p.set_options(multiplier=100, tick_s=0.2)
        await p.play()
        assert await _wait(lambda: p.state == "held")
        await p.seek(1.0)
        assert p.state == "paused" and p.held_at is None

    asyncio.run(run())


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SPOOFER_DATA_DIR", str(tmp_path))
    from spoofer import server
    from spoofer.store import Store

    server.app.state.s = server.AppState()
    server.app.state.s.store = Store(tmp_path / "data.json")
    with TestClient(server.app, base_url="http://127.0.0.1:8765") as c:
        yield c


def test_api_hold_continue_and_laps(client):
    dev = client.post("/api/connect", json={"driver": "mock"}).json()["device"]
    assert dev["ios_version"] == "27"
    body = {"name": "Hold", "waypoints": [{"lat": A[0], "lon": A[1]}, {"lat": B[0], "lon": B[1], "hold": True},
                                          {"lat": C[0], "lon": C[1]}],
            "legs": [{"mode": "straight", "cruise_kmh": 36}, {"mode": "straight"}],
            "settings": {"default_cruise_kmh": 36, "accel_ms2": 2, "decel_ms2": 2}}
    data = client.post("/api/route/build", json=body).json()
    assert data["summary"]["holds"] == 1
    st = client.post(f"/api/player/load/{data['id']}", json={}).json()
    assert len(st["holds"]) == 1 and st["holds"][0][1] == 1
    st = client.post("/api/player-options", json={"lap_limit": 3, "loop": "loop"}).json()
    assert st["lap_limit"] == 3 and st["lap"] == 1
    assert client.post("/api/player-options", json={"lap_limit": -2}).status_code == 400
    assert client.post("/api/player/continue", json={}).status_code == 200  # no-op unless held
    assert client.get("/api/devices?driver=mock").json()["devices"][0]["ios_version"] == "27"
