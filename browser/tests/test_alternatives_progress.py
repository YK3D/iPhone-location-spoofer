"""Route-build progress stream, alternative routes and the OSRM request limit (no internet: mocked)."""

import asyncio
import json
import re

import httpx
import pytest
from fastapi.testclient import TestClient

from spoofer import geo, routing


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SPOOFER_DATA_DIR", str(tmp_path))
    from spoofer import server
    from spoofer.store import Store

    server.app.state.s = server.AppState()
    server.app.state.s.store = Store(tmp_path / "data.json")
    with TestClient(server.app, base_url="http://127.0.0.1:8765") as c:
        yield c


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


def ndjson(text):
    return [json.loads(line) for line in text.splitlines() if line.strip()]


# ---------------------------------------------------------------- progress stream
def test_build_stream_reports_progress_then_result(client):
    r = client.post("/api/route/build?stream=1", json=ROUTE)
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/x-ndjson")
    events = ndjson(r.text)
    progress = [e for e in events if e["type"] == "progress"]
    assert events[-1]["type"] == "result"
    assert len(progress) >= 4
    ps = [e["p"] for e in progress]
    assert ps == sorted(ps) and 0 < ps[0] < ps[-1] < 1
    assert all(e["next"] >= e["p"] for e in progress)
    msgs = [e["msg"] for e in progress]
    assert msgs[0] == "Checking 3 checkpoints"
    assert "Drawing a straight line · leg 2 of 2" in msgs
    assert "Calculating the ETA" in msgs
    data = events[-1]["data"]
    assert data["summary"]["duration_s"] > 5 and len(data["legs"]) == 2
    assert data["alternatives"] == [] and data["option"]["label"] == "A"
    assert client.post(f"/api/player/load/{data['id']}", json={}).status_code == 200


def test_build_stream_errors_arrive_as_a_line(client):
    bad = dict(ROUTE, legs=ROUTE["legs"][:1])
    events = ndjson(client.post("/api/route/build?stream=1", json=bad).text)
    assert events[-1] == {"type": "error", "status": 400, "detail": "Expected 2 legs, got 1"}
    events = ndjson(client.post("/api/route/build?stream=1", json=dict(ROUTE, provider="google")).text)
    assert events[-1]["type"] == "error" and "API key" in events[-1]["detail"]
    # request validation still fails fast with a normal JSON error
    assert client.post("/api/route/build?stream=1", json=dict(ROUTE, alternatives=9)).status_code == 422


def test_preview_rows_carry_distance(client):
    data = client.post("/api/route/build", json=ROUTE).json()
    rows = data["preview"]
    assert all(len(row) == 5 for row in rows)
    assert rows[0][4] == 0 and rows[-1][4] == pytest.approx(data["summary"]["distance_m"], abs=0.2)
    assert [row[4] for row in rows] == sorted(row[4] for row in rows)


# ---------------------------------------------------------------- OSRM alternatives + detours
A = (51.5, -0.12)
B = geo.destination(A, 90, 3000)  # 3 km east


def _line(*pts):
    return [[p[1], p[0]] for p in pts]


def _route(coords, nodes_per_leg, duration, distance, turn=None):
    legs = []
    for k, nodes in enumerate(nodes_per_leg):
        steps = [{"maneuver": {"type": "depart", "bearing_after": 90}}, {"maneuver": {"type": "arrive", "bearing_before": 90}}]
        if turn and k == 0:
            steps[-1]["maneuver"]["bearing_before"] = turn[0]
        if turn and k == 1:
            steps[0]["maneuver"]["bearing_after"] = turn[1]
        legs.append({"annotation": {"speed": [10.0] * (len(nodes) - 1), "nodes": nodes}, "steps": steps})
    return {"duration": duration, "distance": distance, "geometry": {"coordinates": coords}, "legs": legs}


def _grid_entry(via):
    """Which VIA_GRID entry a via point came from (the main route runs due east from A to B)."""
    x = geo.haversine_m(A, (A[0], via[1])) / 3000
    y = geo.haversine_m((A[0], via[1]), via) / 3000
    south = via[0] < A[0]  # right of the direction of travel = positive offset
    return min(routing.VIA_GRID, key=lambda g: abs(g[0] - x) + abs(abs(g[1]) - y) + (0 if (g[1] > 0) == south else 9))


def _osrm_handler(seen):
    south = geo.destination(geo.destination(A, 90, 1050), 180, 660)
    north = geo.destination(geo.destination(A, 90, 1500), 0, 300)
    main = _route(_line(A, geo.destination(A, 90, 1000), geo.destination(A, 90, 2000), B), [[1, 2, 3, 4]], 300, 3000)
    native = _route(_line(A, north, B), [[1, 5, 6, 4]], 330, 3200)

    def handler(req):
        url = str(req.url)
        seen.append(url)
        path = re.search(r"/driving/([^?]+)", url).group(1)
        pts = [(float(c.split(",")[1]), float(c.split(",")[0])) for c in path.split(";")]
        if len(pts) == 2:
            n = int(req.url.params.get("alternatives", "0"))
            return httpx.Response(200, json={"code": "Ok", "routes": [main, native][: 1 + n]})
        via = pts[1]
        g = _grid_entry(via)
        if g in ((0.5, 0.15), (0.65, -0.22)):  # turns back at the via point
            r = _route(_line(A, via, B), [[1, 10], [10, 4]], 340, 3300, turn=(180, 0))
        elif g == (0.5, -0.15):  # the same roads as the main route
            r = _route(_line(A, via, B), [[1, 2, 3], [3, 4]], 310, 3050)
        elif g == (0.35, 0.22):  # a real detour
            r = _route(_line(A, south, B), [[1, 7, 8], [8, 9, 4]], 360, 3600)
        elif g == (0.65, 0.22):  # a near miss: 1.7x the main route's time
            r = _route(_line(A, via, B), [[1, 20, 21], [21, 22, 4]], 510, 3700)
        elif g == (0.5, 0.3):  # the real detour's roads again
            r = _route(_line(A, south, B), [[1, 7, 8], [8, 9, 4]], 365, 3650)
        else:  # far too slow
            r = _route(_line(A, via, B), [[1, 11, 12], [12, 4]], 1000, 3500)
        return httpx.Response(200, json={"code": "Ok", "routes": [r]})

    return handler


def test_osrm_alternatives_fill_up_with_filtered_detours(monkeypatch):
    seen = []
    monkeypatch.setattr(routing, "_client", httpx.AsyncClient(transport=httpx.MockTransport(_osrm_handler(seen))))
    budget = routing.ViaBudget()
    reports = []

    async def report(msg):
        reports.append(msg)

    res = asyncio.run(routing.route_options(A, B, "car", count=3, budget=budget, report=report))
    assert "alternatives=3" in seen[0]
    # one strict pass, then the near miss fills the third place; spikes, copies and slow ones never do
    assert [r.kind for r in res] == ["main", "alternative", "detour", "detour"]
    assert [r.ref_duration_s for r in res] == [300, 330, 360, 510]
    assert all(r.points[0] == A and r.points[-1] == B for r in res)
    assert budget.left == routing.MAX_VIA_REQUESTS - 8  # 4 via points per missing alternative
    assert "Searching for alternative routes (1 of 3 found)" in reports
    # a second build reuses the cached result: no new requests
    n = len(seen)
    asyncio.run(routing.route_options(A, B, "car", count=3, budget=routing.ViaBudget()))
    assert len(seen) == n


def test_detours_can_be_skipped(monkeypatch):
    seen = []
    monkeypatch.setattr(routing, "_client", httpx.AsyncClient(transport=httpx.MockTransport(_osrm_handler(seen))))
    res = asyncio.run(routing.route_options(A, B, "car", count=3, budget=routing.ViaBudget(), detours=False))
    assert len(seen) == 1 and [r.kind for r in res] == ["main", "alternative"]
    # cached separately from a search with detours
    res = asyncio.run(routing.route_options(A, B, "car", count=3, budget=routing.ViaBudget()))
    assert len(res) == 4


def test_via_points_follow_the_route_direction():
    # a route heading north: "right of travel" is east
    pts = [A, geo.destination(A, 0, 2000)]
    assert routing._heading_at_fraction(pts, 0.5) == pytest.approx(0, abs=0.01)
    bend = [A, geo.destination(A, 90, 1000), geo.destination(geo.destination(A, 90, 1000), 0, 1000)]
    assert routing._heading_at_fraction(bend, 0.25) == pytest.approx(90, abs=0.5)
    assert routing._heading_at_fraction(bend, 0.75) == pytest.approx(0, abs=0.5)


def test_detour_search_respects_the_request_budget(monkeypatch):
    seen = []
    monkeypatch.setattr(routing, "_client", httpx.AsyncClient(transport=httpx.MockTransport(_osrm_handler(seen))))
    res = asyncio.run(routing.route_options(A, B, "car", count=3, budget=routing.ViaBudget(1)))
    assert len(seen) == 2 and [r.kind for r in res] == ["main", "alternative"]
    # cut short by the budget, so it was not cached
    asyncio.run(routing.route_options(A, B, "car", count=3, budget=routing.ViaBudget(0)))
    assert len(seen) == 3


def test_route_build_returns_selectable_alternatives(client, monkeypatch):
    seen = []
    monkeypatch.setattr(routing, "_client", httpx.AsyncClient(transport=httpx.MockTransport(_osrm_handler(seen))))
    body = {"name": "Alt", "alternatives": 2, "waypoints": [{"lat": A[0], "lon": A[1]}, {"lat": B[0], "lon": B[1]}],
            "legs": [{"mode": "car", "cruise_kmh": 40}], "settings": {"default_cruise_kmh": 40, "accel_ms2": 2, "decel_ms2": 2}}
    data = client.post("/api/route/build", json=body).json()
    alts = data["alternatives"]
    assert [o["option"]["label"] for o in [data, *alts]] == ["A", "B", "C"]
    assert alts[0]["option"]["changed_legs"] == [0] and not alts[0]["option"]["detour"]
    assert alts[1]["option"]["detour"]
    assert len({data["id"], *(o["id"] for o in alts)}) == 3
    assert alts[1]["summary"]["distance_m"] > data["summary"]["distance_m"]
    assert client.post(f"/api/player/load/{alts[1]['id']}", json={}).status_code == 200
    assert client.get("/api/status").json()["player"]["name"] == "Alt (C)"


def test_detours_that_drive_a_road_twice_are_detected():
    lap = routing._Candidate([], [], [[1, 13, 14, 15], [15, 14, 16, 4]], 0, 330, 3300, "detour")
    assert lap.doubles_back()  # 14-15 out and back
    through = routing._Candidate([], [], [[1, 17, 18], [17, 18, 4]], 0, 330, 3300, "detour")
    assert not through.doubles_back()  # the via point's own segment ends one leg and starts the next
    assert not routing._Candidate([], [], [[1, 7, 8], [8, 9, 4]], 0, 360, 3600, "detour").doubles_back()


def test_reversals_spot_up_and_back_detours():
    a = (51.5, -0.12)
    up = [geo.destination(a, 0, d) for d in range(0, 801, 100)]
    across = geo.destination(up[-1], 90, 40)
    hook = up + [across] + [geo.destination(across, 180, d) for d in range(100, 801, 100)]
    assert routing._reversals(hook) == 1
    corner = up + [geo.destination(up[-1], 90, d) for d in range(100, 801, 100)]  # a plain 90° turn
    assert routing._reversals(corner) == 0
    assert routing._reversals([a, geo.destination(a, 0, 50)]) == 0
    samples = routing._resample([a, geo.destination(a, 90, 1010)], 50)
    assert len(samples) == 21 and geo.haversine_m(samples[1], samples[2]) == pytest.approx(50, abs=0.01)


def test_rounded_osrm_node_ids_are_unknown_not_repeats():
    # OSRM prints node ids >= 1e10 as rounded floats; two different nodes then look identical
    rt = {"duration": 300, "distance": 3000, "geometry": {"coordinates": [[-0.12, 51.5], [-0.11, 51.5], [-0.1, 51.5], [-0.09, 51.5]]},
          "legs": [{"annotation": {"speed": [10, 10, 10], "nodes": json.loads("[1, 1.134297535e+10, 1.134297535e+10, 4]")}, "steps": []}]}
    c = routing._parse_osrm(rt, "detour")
    assert c.nodes == [[1, routing.UNKNOWN_NODE, routing.UNKNOWN_NODE, 4]] and len(c.speeds) == 3
    assert not c.doubles_back() and c.pairs() == set()


def test_overpass_query_skips_unknown_node_ids(monkeypatch):
    from spoofer import road_speed

    queries = []

    def handler(req):
        queries.append(req.content.decode())
        return httpx.Response(200, json={"elements": [{"type": "way", "nodes": [1, 2], "tags": {"highway": "primary", "maxspeed": "50"}}]})

    infos = asyncio.run(road_speed.fetch_osm_roads_multi(httpx.AsyncClient(transport=httpx.MockTransport(handler)), [[1, 2, -1, 3]]))
    assert "-1" not in queries[0] and "1%2C2%2C3" in queries[0]
    assert infos[0].maxspeed_kmh == [50.0, None, None]


# ---------------------------------------------------------------- Google alternatives
def test_google_alternatives_come_from_one_request(monkeypatch):
    from test_links_google_roads import _encode

    bodies = []

    def handler(req):
        bodies.append(json.loads(req.content))
        routes = []
        for k in range(3):
            mid = geo.destination(geo.destination(A, 90, 1500), 0, 200 * k)
            routes.append({"duration": f"{300 + 20 * k}s", "distanceMeters": 3000 + 100 * k,
                           "polyline": {"encodedPolyline": _encode([A, mid, B])},
                           "legs": [{"steps": [{"distanceMeters": 3000, "staticDuration": "300s"}]}]})
        return httpx.Response(200, json={"routes": routes})

    monkeypatch.setattr(routing, "_client", httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    res = asyncio.run(routing.route_options(A, B, "car", provider="google", google_key="K", count=2))
    assert len(bodies) == 1 and bodies[0]["computeAlternativeRoutes"] is True
    assert [r.kind for r in res] == ["main", "alternative", "alternative"]
    assert [r.ref_duration_s for r in res] == [300, 320, 340] and not any(r.exportable for r in res)
    asyncio.run(routing.route_options(A, B, "car", provider="google", google_key="K", count=0))
    assert "computeAlternativeRoutes" not in bodies[1]


# ---------------------------------------------------------------- OSRM usage policy
def test_public_osrm_requests_are_spaced_one_second_apart(monkeypatch):
    monkeypatch.setattr(routing, "OSRM_MIN_INTERVAL_S", 1.0)
    monkeypatch.setattr(routing, "_osrm_next", 0.0)
    monkeypatch.setattr(routing.time, "monotonic", lambda: 100.0)
    public = routing.OSRM_URLS["car"]
    assert [routing._osrm_reserve(public) for _ in range(3)] == [0.0, 1.0, 2.0]
    assert routing._osrm_reserve("http://localhost:5000") == 0.0  # your own server is not throttled
