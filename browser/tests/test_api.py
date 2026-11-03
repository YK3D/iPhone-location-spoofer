"""End-to-end API tests with the built-in Simulator driver (no iPhone, no internet: straight legs)."""

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SPOOFER_DATA_DIR", str(tmp_path))
    from spoofer import server
    from spoofer.store import Store

    server.app.state.s = server.AppState()
    server.app.state.s.store = Store(tmp_path / "data.json")
    with TestClient(server.app, base_url="http://127.0.0.1:8765") as c:
        yield c


def connect(c):
    r = c.post("/api/connect", json={"driver": "mock"})
    assert r.status_code == 200, r.text
    return r.json()["device"]


ROUTE = {
    "name": "Test",
    "waypoints": [
        {"lat": 51.5, "lon": -0.12},
        {"lat": 51.501, "lon": -0.12, "dwell_s": 5},
        {"lat": 51.502, "lon": -0.119, "speed_kmh": 10},
    ],
    "legs": [{"mode": "straight", "cruise_kmh": 20}, {"mode": "straight", "ramp": "linear"}],
    "settings": {"default_cruise_kmh": 5, "accel_ms2": 1, "decel_ms2": 1},
}


def test_index_and_static(client):
    assert client.get("/").status_code == 200
    assert client.get("/static/app.js").status_code == 200


def test_teleport_requires_connection(client):
    r = client.post("/api/location/set", json={"lat": 1, "lon": 2})
    assert r.status_code == 409


def test_teleport_and_clear(client):
    connect(client)
    r = client.post("/api/location/set", json={"lat": 48.8584, "lon": 2.2945})
    assert r.status_code == 200
    drv = client.app.state.s.drivers["mock"]
    assert drv.location == (48.8584, 2.2945)
    r = client.post("/api/location/set", json={"lat": 48.86, "lon": 2.30})
    assert r.json()["jump_m"] > 0
    assert client.post("/api/location/set", json={"lat": 100, "lon": 0}).status_code in (400, 422)
    assert client.post("/api/location/clear", json={}).status_code == 200
    assert drv.location is None


def test_build_export_and_play(client):
    connect(client)
    r = client.post("/api/route/build", json=ROUTE)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["summary"]["duration_s"] > 5
    assert len(data["legs"]) == 2 and data["preview"]
    g = client.get(f"/api/gpx/export/{data['id']}?interval=1")
    assert g.status_code == 200 and "<trkpt" in g.text

    assert client.post(f"/api/player/load/{data['id']}", json={}).status_code == 200
    client.post("/api/player-options", json={"multiplier": 50, "tick_s": 0.2})
    assert client.post("/api/player/play", json={}).json()["state"] == "playing"

    import time

    for _ in range(100):
        st = client.get("/api/status").json()["player"]
        if st["state"] == "finished":
            break
        time.sleep(0.1)
    assert st["state"] == "finished", st
    drv = client.app.state.s.drivers["mock"]
    assert len(drv.history) > 3
    end = drv.history[-1]
    assert end[0] == pytest.approx(51.502, abs=1e-5)


def test_closed_route_and_leg_count_check(client):
    body = dict(ROUTE, closed=True)
    r = client.post("/api/route/build", json=body)
    assert r.status_code == 200, r.text
    assert len(r.json()["legs"]) == 3
    bad = dict(ROUTE, legs=ROUTE["legs"][:1])
    assert client.post("/api/route/build", json=bad).status_code == 400


def test_gpx_import_and_timeline(client):
    gpx = (
        '<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>'
        '<trkpt lat="19.0761" lon="72.8775"><time>2026-10-28T20:00:00Z</time></trkpt>'
        '<trkpt lat="19.0764" lon="72.8775"><time>2026-10-28T20:00:20Z</time></trkpt>'
        "</trkseg></trk></gpx>"
    )
    r = client.post("/api/gpx/import", files={"file": ("r.gpx", gpx, "application/gpx+xml")})
    assert r.status_code == 200, r.text
    tr = r.json()["tracks"][0]
    assert tr["timed"] and tr["points"][1][2] == 20
    r = client.post("/api/gpx/timeline", json={"points": tr["points"], "use_times": True})
    assert r.json()["summary"]["duration_s"] == 20
    r = client.post("/api/gpx/timeline", json={"points": tr["points"], "use_times": False, "cruise_kmh": 3.6})
    assert r.json()["summary"]["duration_s"] > 33  # 33 m at <=1 m/s plus accel/decel
    r = client.post("/api/gpx/timeline", json={"points": tr["points"], "use_times": True, "reverse": True})
    assert r.json()["summary"]["duration_s"] == 20


def test_joystick_moves(client):
    connect(client)
    client.post("/api/location/set", json={"lat": 0.0, "lon": 0.0})
    r = client.post("/api/joystick", json={"moving": True, "bearing": 0, "speed_kmh": 360})
    assert r.status_code == 200 and r.json()["state"] == "joystick"
    import time

    time.sleep(1.2)
    client.post("/api/player/stop", json={})
    lat = client.app.state.s.drivers["mock"].location[0]
    assert lat > 0.0003  # ~100 m/s northwards for ~1 s


def test_store_roundtrip(client):
    r = client.put("/api/store", json={"favorites": [{"name": "x", "lat": 1, "lon": 2}], "routes": [], "settings": {"a": 1}})
    assert r.status_code == 200
    assert client.get("/api/store").json()["favorites"][0]["name"] == "x"
    assert client.put("/api/store", json={"favorites": "nope"}).status_code == 400


def test_parse_coords_endpoint(client):
    assert client.post("/api/parse-coords", json={"text": "1.5, 2.5"}).json() == {"lat": 1.5, "lon": 2.5}
    assert client.post("/api/parse-coords", json={"text": "x"}).status_code == 400


def test_route_google_without_key_and_link_parse(client):
    body = dict(ROUTE, provider="google")
    r = client.post("/api/route/build", json=body)
    assert r.status_code == 400 and "API key" in r.json()["detail"]
    r = client.post("/api/links/parse", json={"text": "https://www.google.com/maps/@48.85,2.29,15z"})
    assert r.status_code == 200 and r.json()["stops"][0]["lat"] == 48.85
    r = client.post("/api/links/parse", json={"text": "https://example.com/x"})
    assert r.status_code == 400
    assert client.get("/api/google/status").json() == {"configured": False}
    client.put("/api/store", json={"favorites": [], "routes": [], "settings": {"google_api_key": " KEY "}})
    assert client.get("/api/google/status").json() == {"configured": True}


def test_road_aware_build_reports_extras(client):
    body = dict(ROUTE, settings=dict(ROUTE["settings"], road_aware=True, corner_slowdown=True))
    r = client.post("/api/route/build", json=body)
    assert r.status_code == 200, r.text
    s = r.json()["summary"]
    assert "moving_time_s" in s and s["road_aware"] is True and s["reference_eta_s"] is None
    assert r.json()["exportable"] is True


def test_google_routes_not_exportable(client):
    from spoofer.profile import Leg, ProfileSettings, Waypoint, build_timeline

    a, b = (51.5, -0.12), (51.501, -0.12)
    tl = build_timeline([Waypoint(*a), Waypoint(*b)], [Leg([a, b])], ProfileSettings())
    tid = client.app.state.s.keep_timeline(tl, "g", [], exportable=False)
    r = client.get(f"/api/gpx/export/{tid}")
    assert r.status_code == 403 and "Google" in r.json()["detail"]


def test_closed_route_return_point_has_no_dwell(client):
    body = dict(ROUTE, closed=True)
    body["waypoints"] = [dict(ROUTE["waypoints"][0], dwell_s=30)] + ROUTE["waypoints"][1:]
    r = client.post("/api/route/build", json=body)
    times = r.json()["summary"]["waypoint_times_s"]
    # total duration ends at arrival back at the start: no extra 30 s wait at the end
    assert r.json()["summary"]["duration_s"] == pytest.approx(times[-1], abs=0.2)


def test_rejects_other_sites():
    from spoofer.server import _is_local_request

    assert _is_local_request("127.0.0.1:8765", "")
    assert _is_local_request("localhost:8765", "http://localhost:8765")
    assert not _is_local_request("127.0.0.1:8765", "https://evil.example")
    assert not _is_local_request("evil.example:8765", "")
    assert not _is_local_request("127.0.0.1.evil.example", "")
