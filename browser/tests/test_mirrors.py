"""Several iPhones at once (extra phones follow the main one) and the USB / Wi-Fi connection choice."""

import asyncio
import time

import pytest
from fastapi.testclient import TestClient

from spoofer import geo
from spoofer.device import pmd3
from spoofer.device.base import DeviceError

A = (51.5, -0.12)
B = geo.destination(A, 90, 300)
MAIN, SECOND = "SIMULATED-0001", "SIMULATED-0002"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SPOOFER_DATA_DIR", str(tmp_path))
    from spoofer import server
    from spoofer.store import Store

    server.app.state.s = server.AppState()
    server.app.state.s.store = Store(tmp_path / "data.json")
    with TestClient(server.app, base_url="http://127.0.0.1:8765") as c:
        yield c


def _state():
    from spoofer import server

    return server.app.state.s


def _until(pred, timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False


def _connect_two(client):
    assert client.post("/api/connect", json={"driver": "mock", "udid": MAIN}).status_code == 200
    r = client.post("/api/mirrors", json={"udid": SECOND})
    assert r.status_code == 200, r.text
    return r.json()


def test_two_simulated_phones_and_status(client):
    devices = client.get("/api/devices?driver=mock").json()["devices"]
    assert [d["udid"] for d in devices] == [MAIN, SECOND]
    data = _connect_two(client)
    assert data["mirror"]["name"] == "Simulated iPhone 2" and data["mirror"]["state"] == "ok"
    st = client.get("/api/status").json()
    assert st["device"]["udid"] == MAIN
    assert [m["udid"] for m in st["mirrors"]] == [SECOND]
    assert st["features"]["multi_device"] and st["features"]["wifi"]


def test_mirror_follows_teleport_route_and_stop(client):
    _connect_two(client)
    s = _state()
    main, mirror = s.driver, s.mirrors[SECOND].driver
    client.post("/api/location/set", json={"lat": A[0], "lon": A[1]})
    assert _until(lambda: mirror.location == main.location == pytest.approx(A, abs=1e-5))
    body = {"name": "Two", "waypoints": [{"lat": A[0], "lon": A[1]}, {"lat": B[0], "lon": B[1]}],
            "legs": [{"mode": "straight", "cruise_kmh": 36}],
            "settings": {"default_cruise_kmh": 36, "accel_ms2": 2, "decel_ms2": 2}}
    tid = client.post("/api/route/build", json=body).json()["id"]
    client.post(f"/api/player/load/{tid}", json={})
    assert client.post("/api/player-options", json={"multiplier": 10, "tick_s": 0.2}).status_code == 200
    client.post("/api/player/play", json={})
    assert _until(lambda: client.get("/api/status").json()["player"]["state"] == "finished", 20)
    assert _until(lambda: mirror.location is not None and geo.haversine_m(mirror.location, B) < 1.0)
    assert geo.haversine_m(main.location, B) < 1.0
    assert len(mirror.history) > 5  # it moved along the route, not just to the end
    assert len(mirror.history) >= 0.8 * len(main.history)
    # Stop spoofing clears every phone
    client.post("/api/location/clear", json={})
    assert _until(lambda: mirror.location is None and main.location is None)


def test_a_slow_mirror_never_holds_up_the_main_phone(client):
    _connect_two(client)
    s = _state()
    mirror = s.mirrors[SECOND].driver
    real_set = mirror.set_location

    async def slow(lat, lon):
        await asyncio.sleep(0.4)
        await real_set(lat, lon)

    mirror.set_location = slow
    t0 = time.monotonic()
    for i in range(6):
        client.post("/api/location/set", json={"lat": A[0] + i * 1e-4, "lon": A[1]})
    assert time.monotonic() - t0 < 1.5  # six sends to a 0.4 s phone would take 2.4 s if waited for
    assert s.driver.location == pytest.approx((A[0] + 5e-4, A[1]), abs=1e-7)
    # the mirror skips the positions it fell behind on and ends where the main phone is
    assert _until(lambda: mirror.location == pytest.approx((A[0] + 5e-4, A[1]), abs=1e-7))
    assert s.mirrors[SECOND].sent < 6


def test_a_lost_mirror_is_marked_and_the_rest_keeps_going(client):
    _connect_two(client)
    s = _state()

    async def broken(lat, lon):
        raise DeviceError("Lost the connection to the iPhone")

    s.mirrors[SECOND].driver.set_location = broken
    assert client.post("/api/location/set", json={"lat": A[0], "lon": A[1]}).status_code == 200
    assert _until(lambda: client.get("/api/status").json()["mirrors"][0]["state"] == "lost")
    m = client.get("/api/status").json()["mirrors"][0]
    assert "Lost the connection" in m["error"]
    assert client.post("/api/location/set", json={"lat": B[0], "lon": B[1]}).status_code == 200
    assert s.driver.location == pytest.approx(B, abs=1e-7)
    assert client.delete(f"/api/mirrors/{SECOND}").json()["mirrors"] == []


def test_removing_a_mirror_sends_it_back_to_its_real_location(client):
    _connect_two(client)
    s = _state()
    mirror = s.mirrors[SECOND].driver
    client.post("/api/location/set", json={"lat": A[0], "lon": A[1]})
    assert _until(lambda: mirror.location is not None)
    assert client.delete(f"/api/mirrors/{SECOND}").status_code == 200
    assert mirror.location is None and mirror.info is None
    assert s.driver.location == pytest.approx(A, abs=1e-7)  # the main phone keeps its position
    assert client.delete(f"/api/mirrors/{SECOND}").status_code == 404


def test_new_mirror_catches_up_and_rules(client):
    assert client.post("/api/mirrors", json={"udid": SECOND}).status_code == 409  # no main phone yet
    client.post("/api/connect", json={"driver": "mock", "udid": MAIN})
    client.post("/api/location/set", json={"lat": A[0], "lon": A[1]})
    assert client.post("/api/mirrors", json={"udid": MAIN}).status_code == 409  # that's the main phone
    assert client.post("/api/mirrors", json={"udid": SECOND, "connection": "usb"}).status_code == 200
    s = _state()
    assert _until(lambda: s.mirrors[SECOND].driver.location == pytest.approx(A, abs=1e-7))  # caught up at once
    assert client.post("/api/mirrors", json={"udid": SECOND}).status_code == 409  # already following
    assert client.post("/api/mirrors", json={"udid": "SIMULATED-9999"}).status_code == 409
    assert client.post("/api/mirrors", json={"udid": SECOND, "connection": "bluetooth"}).status_code == 422
    # connecting the main phone to the mirrored one makes it the main phone instead
    client.post("/api/connect", json={"driver": "mock", "udid": SECOND})
    st = client.get("/api/status").json()
    assert st["device"]["udid"] == SECOND and st["mirrors"] == []
    # disconnecting ends the mirrors too
    client.post("/api/mirrors", json={"udid": MAIN})
    client.post("/api/disconnect", json={})
    assert client.get("/api/status").json()["mirrors"] == []


def test_wifi_tool_and_connection_field(client):
    assert client.post("/api/connect", json={"driver": "mock", "connection": "network"}).status_code == 200
    assert client.post("/api/device/wifi", json={}).json()["message"].startswith("Simulator")
    assert client.post("/api/connect", json={"driver": "mock", "connection": "carrier-pigeon"}).status_code == 422


# ---------------------------------------------------------------- pymobiledevice3 driver, faked usbmux
class _Mux:
    def __init__(self, serial, ct):
        self.serial, self.connection_type = serial, ct

    @property
    def is_usb(self):
        return self.connection_type == "USB"


class _Lockdown:
    def __init__(self, ct):
        self.short_info = {"DeviceName": "Test phone", "ProductVersion": "16.7", "ProductType": "iPhone10,1"}
        self.product_version = "16.7"
        self.udid = "00008030-TEST"
        self.service = type("S", (), {"mux_device": _Mux("00008030-TEST", ct)})()

    async def close(self):
        pass


def test_pmd3_lists_a_phone_once_with_both_connections(monkeypatch):
    from pymobiledevice3 import lockdown, usbmux

    async def fake_list(usbmux_address=None):
        return [_Mux("00008030-TEST", "Network"), _Mux("00008030-TEST", "USB"), _Mux("OTHER", "Network")]

    async def fake_lockdown(serial=None, autopair=True, connection_type=None, **kw):
        return _Lockdown(connection_type or "USB")

    monkeypatch.setattr(usbmux, "list_devices", fake_list)
    monkeypatch.setattr(lockdown, "create_using_usbmux", fake_lockdown)
    out = asyncio.run(pmd3.Pmd3Driver().list_devices())
    assert [(d["udid"], d["connection"], d["connections"]) for d in out] == [
        ("00008030-TEST", "USB + Wi-Fi", ["USB", "Wi-Fi"]), ("OTHER", "Wi-Fi", ["Wi-Fi"])]


def test_pmd3_connects_over_the_chosen_connection(monkeypatch):
    from pymobiledevice3 import lockdown

    asked = []

    class NoDeviceConnectedError(Exception):
        pass

    async def fake_lockdown(serial=None, autopair=True, connection_type=None, **kw):
        asked.append(connection_type)
        if connection_type == "Network" and serial == "OFFLINE":
            raise NoDeviceConnectedError()
        return _Lockdown(connection_type or "USB")

    monkeypatch.setattr(lockdown, "create_using_usbmux", fake_lockdown)
    drv = pmd3.Pmd3Driver()

    async def no_mount(provider):
        return ""

    monkeypatch.setattr(drv, "_try_mount", no_mount)
    info = asyncio.run(drv.connect("00008030-TEST", "network"))
    assert info.connection == "Wi-Fi" and asked[-1] == "Network"
    assert info.transport == "Lockdown simulatelocation"
    info = asyncio.run(drv.connect("00008030-TEST", "auto"))
    assert info.connection == "USB" and asked[-1] is None
    asyncio.run(drv.connect("00008030-TEST", "usb"))
    assert asked[-1] == "USB"
    with pytest.raises(DeviceError, match="Allow Wi-Fi connection"):
        asyncio.run(drv.connect("OFFLINE", "network"))
