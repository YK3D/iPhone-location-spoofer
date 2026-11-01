import pytest

from spoofer import geo
from spoofer.gpx_io import parse_gpx, write_gpx
from spoofer.profile import Leg, ProfileSettings, Waypoint, build_timeline

GUIDE_EXAMPLE = """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="manual" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <trkseg>
      <trkpt lat="19.07610" lon="72.87750"><time>2026-10-28T20:00:00Z</time></trkpt>
      <trkpt lat="19.07640" lon="72.87750"><time>2026-10-28T20:00:20Z</time></trkpt>
      <trkpt lat="19.07670" lon="72.87760"><time>2026-10-28T20:00:40Z</time></trkpt>
    </trkseg>
  </trk>
  <rte><name>R</name><rtept lat="1" lon="2"/><rtept lat="3" lon="4"/></rte>
  <wpt lat="5" lon="6"><name>Home</name></wpt>
</gpx>"""


def test_parse_tracks_routes_waypoints():
    tracks = parse_gpx(GUIDE_EXAMPLE.encode())
    kinds = [t.kind for t in tracks]
    assert kinds == ["track", "route", "waypoints"]
    assert tracks[0].timed and len(tracks[0].points) == 3
    assert (tracks[0].points[1].time - tracks[0].points[0].time).total_seconds() == 20
    assert tracks[2].points[0].name == "Home"


def test_parse_rejects_non_gpx():
    with pytest.raises(ValueError):
        parse_gpx(b"<html></html>")
    with pytest.raises(ValueError):
        parse_gpx(b"not xml")


def test_billion_laughs_blocked():
    bomb = b"""<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]>
    <gpx><wpt lat="1" lon="1"><name>&lol2;</name></wpt></gpx>"""
    with pytest.raises(Exception):
        parse_gpx(bomb)


def test_write_then_parse_and_pymobiledevice3_reader(tmp_path):
    a = (19.0761, 72.8775)
    b = geo.destination(a, 0, 200)
    tl = build_timeline([Waypoint(*a), Waypoint(*b)], [Leg([a, b])], ProfileSettings())
    text = write_gpx(tl.sample(1.0), name="Test <&>", waypoints=[(a[0], a[1], "Start")])
    tracks = parse_gpx(text)
    trk = next(t for t in tracks if t.kind == "track")
    assert trk.timed
    span = (trk.points[-1].time - trk.points[0].time).total_seconds()
    assert span == pytest.approx(tl.duration, abs=0.01)

    # The exact reader `simulate-location play` uses must accept the file
    lsb = pytest.importorskip("pymobiledevice3.services.dvt.instruments.location_simulation_base")
    f = tmp_path / "r.gpx"
    f.write_text(text, encoding="utf-8")
    pts = list(lsb.iter_gpx_track_points(str(f)))
    assert len(pts) == len(trk.points)
    assert all(p.time is not None for p in pts)


@pytest.mark.parametrize(
    "text,expect",
    [
        ("19.0761, 72.8775", (19.0761, 72.8775)),
        ("40.7128 -74.0060", (40.7128, -74.006)),
        ("-33.8688,151.2093", (-33.8688, 151.2093)),
        ("40°42'46\"N 74°00'21\"W", (40.712778, -74.005833)),
    ],
)
def test_parse_coordinates(text, expect):
    lat, lon = geo.parse_coordinates(text)
    assert lat == pytest.approx(expect[0], abs=1e-5)
    assert lon == pytest.approx(expect[1], abs=1e-5)


@pytest.mark.parametrize("bad", ["", "abc", "91, 0", "0, 181", "1 2 3"])
def test_parse_coordinates_bad(bad):
    with pytest.raises(ValueError):
        geo.parse_coordinates(bad)


def test_geo_roundtrip():
    a = (10.0, 20.0)
    b = geo.destination(a, 45, 12345)
    assert geo.haversine_m(a, b) == pytest.approx(12345, rel=1e-6)
    assert geo.bearing_deg(a, b) == pytest.approx(45, abs=0.01)
    m = geo.interpolate(a, b, 0.5)
    assert geo.haversine_m(a, m) == pytest.approx(12345 / 2, rel=1e-6)
