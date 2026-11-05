"""Local web server: serves the map UI and the JSON API it uses."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections import OrderedDict
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Awaitable, Callable, Literal, Optional

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__, geo, gmaps_links, google_api, routing
from .feature_tests import FeatureTestError, FeatureTests
from .offline import Bounds, Offline
from .device.base import DeviceDriver, DeviceError
from .device.cli import CliDriver
from .device.mock import MockDriver
from .device.pmd3 import Pmd3Driver
from .gpx_io import parse_gpx, safe_filename, write_gpx
from .mirrors import FanOut, MirrorLink
from .player import Player
from .profile import (
    Leg,
    ProfileSettings,
    Timeline,
    Waypoint,
    build_matching_eta,
    build_timeline,
    timeline_from_timed_points,
)
from .store import Store, data_dir
from .updater import Updater

log = logging.getLogger(__name__)
def _find_ui() -> Path:
    """The shared UI: bundled next to this module in the exe, or ui/ at the repository root."""
    for cand in (Path(__file__).parent / "static", Path(__file__).resolve().parents[2] / "ui"):
        if (cand / "index.html").is_file():
            return cand
    return Path(__file__).parent / "static"


STATIC = _find_ui()
MAX_UPLOAD = 20 * 1024 * 1024
PREVIEW_POINTS = 4000


# ---------------------------------------------------------------- state
class AppState:
    def __init__(self) -> None:
        self.drivers: dict[str, DeviceDriver] = {d.key: d for d in (Pmd3Driver(), CliDriver(), MockDriver())}
        self.driver_key = "pmd3"
        # extra iPhones that follow the main one, by UDID (see mirrors.py)
        self.mirrors: dict[str, MirrorLink] = {}
        self.fanout = FanOut(lambda: self.driver, lambda: list(self.mirrors.values()))
        self.player = Player(lambda: self.fanout)
        self.timelines: "OrderedDict[str, tuple[Timeline, str, list, bool]]" = OrderedDict()
        self.store = Store()
        self.updater = Updater()  # replaced by __main__ with the real one; disabled from source
        self.offline = Offline(data_dir())
        self.feature_tests = FeatureTests(data_dir())

    @property
    def driver(self) -> DeviceDriver:
        return self.drivers[self.driver_key]

    async def drop_mirror(self, udid: str, clear: bool = False) -> bool:
        link = self.mirrors.pop(udid, None)
        if link is None:
            return False
        await link.close(clear)
        return True

    async def drop_mirrors(self, clear: bool = False) -> None:
        for udid in list(self.mirrors):
            await self.drop_mirror(udid, clear)

    def keep_timeline(self, tl: Timeline, name: str, waypoints: list, exportable: bool = True) -> str:
        tid = uuid.uuid4().hex[:12]
        self.timelines[tid] = (tl, name, waypoints, exportable)
        while len(self.timelines) > 20:
            self.timelines.popitem(last=False)
        return tid

    def google_key(self) -> Optional[str]:
        key = (self.store.load().get("settings") or {}).get("google_api_key")
        return key.strip() if isinstance(key, str) and key.strip() else None

    def get_timeline(self, tid: str) -> tuple[Timeline, str, list, bool]:
        try:
            return self.timelines[tid]
        except KeyError:
            raise HTTPException(404, "That route is no longer in memory. Build it again.") from None


@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio

    upd_task = asyncio.create_task(app.state.s.updater.run_periodically())
    yield
    upd_task.cancel()
    try:
        await app.state.s.player.stop()
        await app.state.s.drop_mirrors()
        for d in app.state.s.drivers.values():
            await d.disconnect()
    finally:
        await routing.close()


app = FastAPI(title="iPhone Location Spoofer", version=__version__, lifespan=lifespan)


_LOCAL_HOSTS = ("127.0.0.1", "localhost")


def _is_local_request(host: str, origin: str) -> bool:
    """Only the app's own page may use the API: blocks other websites and DNS rebinding."""
    host_ok = any(host == h or host.startswith(h + ":") for h in _LOCAL_HOSTS)
    return host_ok and (not origin or origin == f"http://{host}")


@app.middleware("http")
async def _local_only(request: Request, call_next):
    if not _is_local_request(request.headers.get("host", ""), request.headers.get("origin", "")):
        return Response("forbidden", status_code=403)
    return await call_next(request)
app.state.s = AppState()


def S() -> AppState:
    return app.state.s


@app.exception_handler(DeviceError)
async def _device_error(_: Request, exc: DeviceError):
    return JSONResponse({"detail": str(exc)}, status_code=409)


@app.exception_handler(routing.RoutingError)
async def _routing_error(_: Request, exc: routing.RoutingError):
    return JSONResponse({"detail": str(exc)}, status_code=502)


@app.exception_handler(google_api.GoogleError)
async def _google_error(_: Request, exc: google_api.GoogleError):
    return JSONResponse({"detail": str(exc)}, status_code=502)


@app.exception_handler(FeatureTestError)
async def _feature_test_error(_: Request, exc: FeatureTestError):
    return JSONResponse({"detail": str(exc)}, status_code=exc.status)


@app.exception_handler(ValueError)
async def _value_error(_: Request, exc: ValueError):
    return JSONResponse({"detail": str(exc)}, status_code=400)


# ---------------------------------------------------------------- models
class LatLonIn(BaseModel):
    lat: float
    lon: float


class TextIn(BaseModel):
    text: str


class ConnectIn(BaseModel):
    driver: Literal["pmd3", "cli", "mock"] = "pmd3"
    udid: Optional[str] = None
    connection: Literal["auto", "usb", "network"] = "auto"


class MirrorIn(BaseModel):
    udid: str
    connection: Literal["auto", "usb", "network"] = "auto"


class UdidIn(BaseModel):
    udid: Optional[str] = None


MAX_MIRRORS = 8


class WaypointIn(BaseModel):
    lat: float
    lon: float
    name: Optional[str] = None
    speed_kmh: Optional[float] = Field(None, ge=0, le=5000)
    dwell_s: float = Field(0, ge=0, le=86400)
    hold: bool = False  # stop here until the user presses Continue


class LegIn(BaseModel):
    mode: Literal["car", "bike", "foot", "sea", "straight"] = "foot"
    cruise_kmh: Optional[float] = Field(None, gt=0, le=5000)
    ramp: Literal["accel", "linear"] = "accel"


class SettingsIn(BaseModel):
    default_cruise_kmh: float = Field(5.0, gt=0, le=5000)
    accel_ms2: float = Field(1.0, gt=0, le=100)
    decel_ms2: float = Field(1.0, gt=0, le=100)
    start_from_rest: bool = True
    stop_at_end: bool = True
    # experimental road-aware driving
    road_aware: bool = False
    road_data: bool = False  # also fetch public speed limits (OpenStreetMap Overpass)
    match_eta: bool = True  # tune the driving-style factor towards the routing service's ETA
    speed_factor: float = Field(1.0, gt=0.1, le=3)
    corner_slowdown: bool = False
    # None: each vehicle's own cornering limits (see profile.VEHICLES)
    lateral_accel_ms2: Optional[float] = Field(None, gt=0.1, le=10)

    def to_profile(self) -> ProfileSettings:
        return ProfileSettings(
            default_cruise_kmh=self.default_cruise_kmh,
            accel_ms2=self.accel_ms2,
            decel_ms2=self.decel_ms2,
            start_from_rest=self.start_from_rest,
            stop_at_end=self.stop_at_end,
            road_aware=self.road_aware,
            speed_factor=self.speed_factor,
            corner_slowdown=self.corner_slowdown or self.road_aware,
            lateral_accel_ms2=self.lateral_accel_ms2,
        )


class RouteIn(BaseModel):
    name: str = "Route"
    waypoints: list[WaypointIn] = Field(min_length=2, max_length=500)
    legs: list[LegIn]
    settings: SettingsIn = SettingsIn()
    closed: bool = False  # add a final leg back to the start
    provider: Literal["osrm", "google"] = "osrm"
    alternatives: int = Field(0, ge=0, le=routing.MAX_ALTERNATIVES)  # extra route options to look for


class TrackIn(BaseModel):
    name: str = "Imported track"
    points: list[tuple[float, float, Optional[float]]] = Field(min_length=1, max_length=500_000)
    use_times: bool = True
    reverse: bool = False
    cruise_kmh: float = Field(5.0, gt=0, le=5000)
    settings: SettingsIn = SettingsIn()


class PlayerOptionsIn(BaseModel):
    multiplier: Optional[float] = None
    loop: Optional[Literal["once", "loop", "pingpong"]] = None
    jitter_m: Optional[float] = None
    tick_s: Optional[float] = None
    lap_limit: Optional[int] = None  # laps in loop / back-and-forth mode, 0 = no limit


class SeekIn(BaseModel):
    t: float


class JoystickIn(BaseModel):
    moving: bool
    bearing: Optional[float] = None
    speed_kmh: Optional[float] = None


# ---------------------------------------------------------------- helpers
def timeline_payload(
    tid: str, tl: Timeline, legs_geometry: list[list[list[float]]] | None = None, **extra
) -> dict:
    interval = max(1.0, tl.duration / PREVIEW_POINTS)
    samples = tl.sample(interval)
    summary = tl.summary()
    summary.update(extra.pop("summary_extra", {}))
    return {
        "id": tid,
        "summary": summary,
        "legs": legs_geometry,
        **extra,
        # [t s, lat, lon, speed km/h, distance along the route m]
        "preview": [
            [round(p.t, 2), round(p.lat, 7), round(p.lon, 7), round(p.speed_ms * 3.6, 2), round(p.distance_m, 1)]
            for p in samples
        ],
    }


# ---------------------------------------------------------------- device
@app.get("/api/status")
async def status():
    s = S()
    d = s.driver
    return {
        "version": __version__,
        "app": "browser",
        "feature_test": None,
        "features": {"cli_driver": True, "tunnel_helper": True, "multi_device": True, "wifi": True},
        "driver": s.driver_key,
        "drivers": [{"key": k, "label": v.label, "live": v.live} for k, v in s.drivers.items()],
        "device": d.info.to_dict() if d.info else None,
        "live": d.live,
        "player": s.player.status(),
        "update": s.updater.status(),
        "mirrors": [m.to_dict() for m in s.mirrors.values()],
    }


@app.get("/api/devices")
async def devices(driver: Literal["pmd3", "cli", "mock"] = "pmd3"):
    return {"devices": await S().drivers[driver].list_devices()}


@app.post("/api/connect")
async def connect(body: ConnectIn):
    s = S()
    await s.player.stop()
    if body.driver != s.driver_key:
        await s.drop_mirrors()
        await s.driver.disconnect()
        s.driver_key = body.driver
    if body.udid:
        await s.drop_mirror(body.udid)  # it becomes the main phone instead
    info = await s.driver.connect(body.udid or None, body.connection)
    await s.drop_mirror(info.udid)
    return {"device": info.to_dict()}


@app.post("/api/disconnect")
async def disconnect():
    s = S()
    await s.player.stop()
    await s.drop_mirrors()
    await s.driver.disconnect()
    return {"ok": True}


@app.post("/api/mirrors")
async def mirror_add(body: MirrorIn):
    """Another iPhone follows the main one: same position, same route, from now on."""
    s = S()
    main = s.driver
    if not main.connected or main.info is None:
        raise DeviceError("Connect the main iPhone first.")
    if not main.live:
        raise DeviceError("Several iPhones at once need the Direct connection (or the Simulator).")
    if body.udid == main.info.udid:
        raise DeviceError("That is the main iPhone already.")
    if body.udid in s.mirrors:
        raise DeviceError("That iPhone already follows the main one.")
    if len(s.mirrors) >= MAX_MIRRORS:
        raise DeviceError(f"Up to {MAX_MIRRORS} extra iPhones can follow the main one.")
    drv = type(main)()
    info = await drv.connect(body.udid, body.connection)
    if info.udid == main.info.udid or info.udid in s.mirrors:
        await drv.disconnect()
        raise DeviceError("That iPhone is connected already.")
    link = MirrorLink(drv)
    s.mirrors[info.udid] = link
    pos = s.player.position
    if pos is not None:
        link.push_set(pos.lat, pos.lon)  # catch up with the main phone straight away
    return {"mirror": link.to_dict(), "mirrors": [m.to_dict() for m in s.mirrors.values()]}


@app.delete("/api/mirrors/{udid}")
async def mirror_remove(udid: str, clear: bool = True):
    """Stop following; by default the phone goes back to its real location."""
    s = S()
    if not await s.drop_mirror(udid, clear):
        raise HTTPException(404, "That iPhone doesn't follow the main one.")
    return {"mirrors": [m.to_dict() for m in s.mirrors.values()]}


@app.post("/api/device/wifi")
async def enable_wifi(body: UdidIn):
    s = S()
    udid = body.udid or (s.driver.info.udid if s.driver.info else None)
    return {"message": await s.driver.enable_wifi(udid)}


@app.post("/api/device/reveal-developer-mode")
async def reveal_dev_mode():
    return {"message": await S().driver.reveal_developer_mode()}


@app.post("/api/device/mount")
async def mount():
    return {"message": await S().driver.mount_developer_image()}


# ---------------------------------------------------------------- location
@app.post("/api/location/set")
async def set_location(body: LatLonIn):
    return await S().player.teleport(body.lat, body.lon)


@app.post("/api/location/clear")
async def clear_location():
    await S().player.clear()
    return {"ok": True}


@app.post("/api/parse-coords")
async def parse_coords(body: TextIn):
    lat, lon = geo.parse_coordinates(body.text)
    return {"lat": lat, "lon": lon}


@app.get("/api/geocode")
async def geocode(q: str):
    return {"results": await routing.geocode(q)}


@app.get("/api/reverse")
async def reverse(lat: float, lon: float):
    return {"name": await routing.reverse_geocode(lat, lon)}


# ---------------------------------------------------------------- routes
Progress = Callable[..., Awaitable[None]]
OPTION_LABELS = "ABCD"
LEG_VERBS = {"car": "Finding the best road route", "bike": "Finding cycle paths", "foot": "Finding footpaths",
             "sea": "Plotting sea lanes", "straight": "Drawing a straight line"}


async def _no_progress(*_a, **_k) -> None:
    return None


def _solve(waypoints, legs, prof, settings: SettingsIn, ref_complete: bool, ref_total: float):
    if settings.road_aware and settings.match_eta and ref_complete and ref_total > 0:
        return build_matching_eta(waypoints, legs, prof, ref_total)
    return build_timeline(waypoints, legs, prof), prof.speed_factor


async def _build_route(body: RouteIn, progress: Progress = _no_progress) -> dict:
    """Route every leg (plus alternatives), then solve one timeline per route option.

    ``progress(fraction, message, next_fraction)`` reports each stage; the UI animates its bar
    from fraction towards next_fraction while a stage runs."""
    wps = list(body.waypoints)
    legs_in = list(body.legs)
    if body.closed:
        first = wps[0]
        # the return checkpoint is the start's location only (not its wait time or speed)
        wps.append(WaypointIn(lat=first.lat, lon=first.lon, name=(first.name or "Start") + " (return)"))
        if len(legs_in) == len(body.waypoints) - 1:
            legs_in.append(legs_in[-1].model_copy() if legs_in else LegIn())
    if len(legs_in) != len(wps) - 1:
        raise HTTPException(400, f"Expected {len(wps) - 1} legs, got {len(legs_in)}")
    for w in wps:
        geo.validate_latlon(w.lat, w.lon)

    settings = body.settings
    key = S().google_key() if body.provider == "google" else None
    if body.provider == "google" and not key:
        raise HTTPException(400, "Google routing needs your Google Maps API key (Settings).")

    n = len(legs_in)
    await progress(0.01, f"Checking {len(body.waypoints)} checkpoints", 0.03)
    budget = routing.ViaBudget()
    leg_options: list[list[routing.RouteResult]] = []
    # Option k uses alternative k on every leg that has one, so one leg with enough alternatives
    # is enough: once some leg has them, later legs skip the (slow) detour search.
    best = 0
    for i, li in enumerate(legs_in):
        a, b = (wps[i].lat, wps[i].lon), (wps[i + 1].lat, wps[i + 1].lon)
        p0, p1 = 0.03 + 0.72 * i / n, 0.03 + 0.72 * (i + 1) / n
        suffix = f" · leg {i + 1} of {n}" if n > 1 else ""
        verb = "Asking Google Maps for the route" if body.provider == "google" and li.mode in routing.ROAD_MODES else LEG_VERBS[li.mode]
        await progress(p0, verb + suffix, p1)

        async def sub(msg: str, p0: float = p0, p1: float = p1, suffix: str = suffix) -> None:
            await progress(p0, msg + suffix, p1)

        try:
            opts = await routing.route_options(
                a, b, li.mode, provider=body.provider, google_key=key,
                road_data=settings.road_aware and settings.road_data,
                count=body.alternatives, budget=budget, report=sub, detours=best < body.alternatives,
            )
        except routing.RoutingError as e:
            raise routing.RoutingError(f"Leg {i + 1} ({li.mode}): {e}") from e
        leg_options.append(opts)
        best = max(best, len(opts) - 1)

    waypoints = [Waypoint(w.lat, w.lon, w.speed_kmh, w.dwell_s, w.hold) for w in wps]
    names = [(w.lat, w.lon, w.name or f"Checkpoint {i + 1}") for i, w in enumerate(wps)]
    prof = settings.to_profile()
    n_opts = max(len(o) for o in leg_options)
    built: list[dict] = []
    for j in range(n_opts):
        chosen = [opts[j] if j < len(opts) else opts[0] for opts in leg_options]
        legs: list[Leg] = []
        geometry: list[list[list[float]]] = []
        providers: list[str] = []
        notes: list[str] = []
        features: dict = {"uturns": 0, "offnet_m": 0.0, "highway_segments": 0, "restricted_segments": 0}
        ref_total = 0.0
        ref_complete = True
        exportable = True
        for i, (li, res) in enumerate(zip(legs_in, chosen)):
            legs.append(Leg(points=res.points, cruise_kmh=li.cruise_kmh, ramp=li.ramp, zones=res.zones,
                            mode=li.mode, roundabouts=res.roundabouts))
            geometry.append([[round(p[0], 7), round(p[1], 7)] for p in res.points])
            providers.append(res.provider)
            notes.extend(f"Leg {i + 1}: {nt}" for nt in res.notes)
            for k, v in res.features.items():
                features[k] = features.get(k, 0) + v
            exportable = exportable and res.exportable
            if res.ref_duration_s:
                ref_total += res.ref_duration_s
            elif li.mode != "straight" or n == 1:
                ref_complete = False
        q0, q1 = 0.76 + 0.2 * j / n_opts, 0.76 + 0.2 * (j + 1) / n_opts
        which = f" · route {j + 1} of {n_opts}" if n_opts > 1 else ""
        if prof.corner_slowdown:
            await progress(q0, "Identifying turns and U-turns" + which, q0 + (q1 - q0) * 0.3)
        source = "Google" if "google" in providers else "OSRM"
        if settings.road_aware and settings.match_eta and ref_complete and ref_total > 0:
            msg = f"Matching the {source} ETA with your driving style"
        elif settings.road_aware:
            msg = f"Applying your driving style ({round(prof.speed_factor * 100)}%)"
        else:
            msg = "Applying acceleration and braking"
        await progress(q0 + (q1 - q0) * 0.3, msg + which, q0 + (q1 - q0) * 0.8)
        tl, factor = await asyncio.to_thread(_solve, waypoints, legs, prof, settings, ref_complete, ref_total)
        await progress(q0 + (q1 - q0) * 0.8, "Calculating the ETA" + which, q1)
        built.append({
            "tl": tl, "geometry": geometry, "providers": providers, "exportable": exportable,
            "changed_legs": [i for i, opts in enumerate(leg_options) if 0 < j < len(opts)],
            "detour": any(r.kind == "detour" for r in chosen),
            "extra": {
                "reference_eta_s": round(ref_total, 1) if ref_complete and ref_total > 0 else None,
                "reference_source": "Google" if "google" in providers else ("OSRM" if "osrm" in providers else None),
                "speed_factor": round(factor, 3),
                "features": {k: (round(v, 1) if isinstance(v, float) else v) for k, v in features.items()},
                "notes": notes,
                "road_aware": settings.road_aware,
            },
        })
    # Route A is the routing service's main route; the alternatives follow, quickest first.
    built[1:] = sorted(built[1:], key=lambda o: o["tl"].duration)
    results: list[dict] = []
    for rank, o in enumerate(built):
        label = OPTION_LABELS[rank]
        tid = S().keep_timeline(o["tl"], body.name if rank == 0 else f"{body.name} ({label})", names, o["exportable"])
        payload = await asyncio.to_thread(
            timeline_payload, tid, o["tl"], o["geometry"], providers=o["providers"], exportable=o["exportable"],
            summary_extra=o["extra"],
        )
        payload["option"] = {"index": rank, "label": label, "changed_legs": o["changed_legs"], "detour": o["detour"]}
        results.append(payload)
    top = results[0]
    top["alternatives"] = results[1:]
    top["alternatives_requested"] = body.alternatives
    return top


def _error_status(exc: Exception) -> tuple[int, str]:
    if isinstance(exc, HTTPException):
        return exc.status_code, str(exc.detail)
    if isinstance(exc, (routing.RoutingError, google_api.GoogleError)):
        return 502, str(exc)
    if isinstance(exc, DeviceError):
        return 409, str(exc)
    if isinstance(exc, ValueError):
        return 400, str(exc)
    return 500, f"Building the route failed: {exc.__class__.__name__}: {exc}"


@app.post("/api/route/build")
async def build_route(body: RouteIn, stream: bool = False):
    """Without ``stream`` the response is the route as JSON. With ``?stream=1`` it is NDJSON:
    {"type": "progress", "p", "next", "msg"} lines, then one {"type": "result", "data"} or
    {"type": "error", "status", "detail"} line."""
    if not stream:
        return await _build_route(body)
    queue: asyncio.Queue = asyncio.Queue()

    async def progress(p: float, msg: str, nxt: Optional[float] = None) -> None:
        await queue.put({"type": "progress", "p": round(p, 3), "next": round(max(p, nxt or p), 3), "msg": msg})

    async def run() -> None:
        try:
            await queue.put({"type": "result", "data": await _build_route(body, progress)})
        except asyncio.CancelledError:
            raise
        except Exception as e:  # sent to the UI as an error line; the HTTP status is already 200
            status, detail = _error_status(e)
            if status >= 500 and not isinstance(e, (routing.RoutingError, google_api.GoogleError)):
                log.exception("route build failed")
            await queue.put({"type": "error", "status": status, "detail": detail})
        finally:
            await queue.put(None)

    task = asyncio.create_task(run())

    async def lines():
        try:
            while (item := await queue.get()) is not None:
                yield json.dumps(item, separators=(",", ":")) + "\n"
        finally:
            if not task.done():  # the window was closed mid-build
                task.cancel()

    return StreamingResponse(lines(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})


@app.post("/api/gpx/import")
async def gpx_import(file: UploadFile = File(...)):
    data = await file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "GPX file is larger than 20 MB")
    tracks = parse_gpx(data)
    out = []
    for tr in tracks:
        t0 = next((p.time for p in tr.points if p.time is not None), None)
        out.append(
            {
                "name": tr.name,
                "kind": tr.kind,
                "timed": tr.timed,
                "points": [
                    [p.lat, p.lon, (p.time - t0).total_seconds() if (p.time and t0) else None] for p in tr.points
                ],
                "names": [p.name for p in tr.points],
            }
        )
    return {"filename": file.filename, "tracks": out}


@app.post("/api/gpx/timeline")
async def gpx_timeline(body: TrackIn):
    pts = list(body.points)
    for lat, lon, _ in pts:
        geo.validate_latlon(lat, lon)
    timed = len(pts) > 1 and all(p[2] is not None for p in pts)
    if body.reverse:
        if timed:
            end = max(p[2] for p in pts)  # type: ignore[type-var]
            pts = [(lat, lon, end - t) for lat, lon, t in reversed(pts)]  # type: ignore[operator]
        else:
            pts = list(reversed(pts))
    if body.use_times and timed:
        if any(b[2] < a[2] for a, b in zip(pts, pts[1:])):  # type: ignore[operator]
            raise ValueError("The GPX timestamps are not in order; untick 'Use the file's timestamps'.")
        tl = timeline_from_timed_points([(t, lat, lon) for lat, lon, t in pts])  # type: ignore[misc]
    else:
        if len(pts) < 2:
            raise ValueError("Need at least two points to make a route")
        ends = [Waypoint(pts[0][0], pts[0][1]), Waypoint(pts[-1][0], pts[-1][1])]
        leg = Leg(points=[(p[0], p[1]) for p in pts], cruise_kmh=body.cruise_kmh)
        tl = build_timeline(ends, [leg], body.settings.to_profile())
    tid = S().keep_timeline(tl, body.name, [])
    return timeline_payload(
        tid, tl, [[[round(p[0], 7), round(p[1], 7)] for p in pts]], providers=["gpx"], exportable=True
    )


@app.get("/api/gpx/export/{tid}")
async def gpx_export(tid: str, interval: float = 1.0):
    if not 0.2 <= interval <= 60:
        raise HTTPException(400, "interval must be 0.2-60 s")
    tl, name, wps, exportable = S().get_timeline(tid)
    if not exportable:
        raise HTTPException(
            403,
            "Routes from Google cannot be saved as GPX (Google's terms restrict storing Routes API "
            "content). Switch the route to OpenStreetMap routing to export it.",
        )
    if tl.duration / interval > 1_000_000:
        raise HTTPException(400, "That would be more than a million points; use a larger interval.")
    text = write_gpx(tl.sample(interval), name=name, waypoints=wps)
    fname = safe_filename(name) + ".gpx"
    return Response(
        text,
        media_type="application/gpx+xml",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# ---------------------------------------------------------------- player
@app.post("/api/player/load/{tid}")
async def player_load(tid: str):
    tl, name, _, _ = S().get_timeline(tid)
    await S().player.load(tl, name)
    return S().player.status()


@app.post("/api/player/{action}")
async def player_action(action: Literal["play", "pause", "resume", "continue", "stop", "unload"]):
    p = S().player
    await getattr(p, "continue_" if action == "continue" else action)()
    return p.status()


@app.post("/api/player-seek")
async def player_seek(body: SeekIn):
    await S().player.seek(body.t)
    return S().player.status()


@app.post("/api/player-options")
async def player_options(body: PlayerOptionsIn):
    await S().player.set_options(body.multiplier, body.loop, body.jitter_m, body.tick_s, body.lap_limit)
    return S().player.status()


@app.post("/api/joystick")
async def joystick(body: JoystickIn):
    await S().player.joystick(body.moving, body.bearing, body.speed_kmh)
    return S().player.status()


# ---------------------------------------------------------------- updates / helpers
@app.get("/api/update")
async def update_status():
    u = S().updater
    return {**u.status(), "staged": u.staged_version() if u.enabled else None}


@app.post("/api/update/check")
async def update_check():
    return await S().updater.check()


@app.post("/api/update/install")
async def update_install():
    import asyncio

    u = S().updater
    if not u.enabled:
        raise HTTPException(400, "Updates only work in the LocationSpoofer.exe build. From source, run: git pull")
    if not u.staged_version():
        raise HTTPException(409, "No downloaded update is ready. Press 'Check for updates' first.")
    await S().player.stop()
    if not u.swap_in_staged():
        raise HTTPException(500, u.error or "Could not install the update")
    app.state.restart_requested = True
    server = getattr(app.state, "server", None)

    async def stop_soon():
        await asyncio.sleep(0.5)  # let this response reach the browser
        if server is not None:
            server.should_exit = True

    asyncio.create_task(stop_soon())
    return {"restarting": True}


@app.post("/api/tunneld/start")
async def tunneld_start():
    from .helpers import start_tunneld_elevated

    try:
        return {"message": start_tunneld_elevated()}
    except RuntimeError as e:
        raise DeviceError(str(e)) from e


# ---------------------------------------------------------------- Google Maps links / API
class LinkIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


@app.post("/api/links/parse")
async def parse_link(body: LinkIn):
    try:
        parsed = await gmaps_links.parse_any(body.text)
    except gmaps_links.LinkError as e:
        raise HTTPException(400, str(e)) from e
    # Place names need coordinates: geocode them (Nominatim allows 1 request per second).
    unresolved = [st for st in parsed.stops if st.lat is None]
    for i, st in enumerate(unresolved):
        if i:
            await asyncio.sleep(1.1)
        results = await routing.geocode(st.query, limit=1)
        if not results:
            raise HTTPException(404, f"Could not find '{st.query}' on the map")
        st.lat, st.lon = results[0]["lat"], results[0]["lon"]
        st.name = st.name or results[0]["name"]
    for st in parsed.stops:
        geo.validate_latlon(st.lat, st.lon)  # type: ignore[arg-type]
    return parsed.to_dict()


@app.get("/api/google/status")
async def google_status():
    return {"configured": S().google_key() is not None}


class TileSessionIn(BaseModel):
    map_type: Literal["roadmap", "satellite", "terrain"] = "roadmap"
    language: str = "en-US"
    region: str = "US"


@app.post("/api/google/tile-session")
async def google_tile_session(body: TileSessionIn):
    key = S().google_key()
    if not key:
        raise HTTPException(400, "Add your Google Maps API key in Settings first.")
    sess = await google_api.create_tile_session(routing.client(), key, body.map_type, body.language, body.region)
    # The browser loads tiles straight from Google, so it needs the key (the user's own key,
    # on their own computer). Restrict the key to the Map Tiles and Routes APIs in Google Cloud.
    return {"session": sess.get("session"), "expiry": sess.get("expiry"), "key": key,
            "tile_size": sess.get("tileWidth", 256)}


@app.get("/api/google/copyright")
async def google_copyright(session: str, zoom: int, north: float, south: float, east: float, west: float):
    key = S().google_key()
    if not key:
        return {"copyright": ""}
    text = await google_api.viewport_copyright(routing.client(), key, session, zoom, north, south, east, west)
    return {"copyright": text}


# ---------------------------------------------------------------- storage
@app.get("/api/store")
async def store_get():
    return S().store.load()


@app.put("/api/store")
async def store_put(body: dict):
    return S().store.save(body)


# ---------------------------------------------------------------- offline maps
@app.get("/ofm/{path:path}")
async def ofm(request: Request):
    # the raw (still percent-encoded) path, as the cache and OpenFreeMap use it
    raw = request.scope.get("raw_path", b"").decode("latin-1")
    path = raw.split("?", 1)[0].removeprefix("/ofm/")
    status_code, ctype, body = await S().offline.proxy(path)
    return Response(body, status_code=status_code, media_type=ctype, headers={"Cache-Control": "no-cache"})


class BoundsIn(BaseModel):
    south: float
    west: float
    north: float
    east: float


class EstimateIn(BaseModel):
    bounds: BoundsIn
    min_zoom: Optional[int] = Field(None, ge=0, le=22)
    max_zoom: int = Field(..., ge=0, le=22)


class DownloadIn(EstimateIn):
    name: Optional[str] = None


@app.get("/api/offline")
async def offline_status():
    return S().offline.status()


@app.post("/api/offline/estimate")
async def offline_estimate(body: EstimateIn):
    return Offline.estimate(Bounds(**body.bounds.model_dump()), body.min_zoom or 0, body.max_zoom)


@app.post("/api/offline/download")
async def offline_download(body: DownloadIn):
    try:
        return S().offline.start(body.name, Bounds(**body.bounds.model_dump()), body.min_zoom, body.max_zoom)
    except RuntimeError as e:
        raise HTTPException(400, str(e)) from None


@app.post("/api/offline/cancel")
async def offline_cancel():
    S().offline.cancel()
    return S().offline.status()


@app.delete("/api/offline/{area_id}")
async def offline_delete(area_id: str):
    try:
        await asyncio.to_thread(S().offline.delete_area, area_id)
    except LookupError as e:
        raise HTTPException(404, str(e)) from None
    return S().offline.status()


# ---------------------------------------------------------------- feature tests
class UnlockIn(BaseModel):
    password: str
    remember: bool = False


class FeatureTestOpenIn(BaseModel):
    pr: int


@app.get("/api/feature-tests")
async def feature_tests_list():
    return await S().feature_tests.list()


@app.post("/api/feature-tests/unlock")
async def feature_tests_unlock(body: UnlockIn):
    return await S().feature_tests.unlock(body.password, body.remember)


@app.get("/api/feature-tests/progress")
async def feature_tests_progress():
    return S().feature_tests.progress()


@app.post("/api/feature-tests/lock")
async def feature_tests_lock():
    S().feature_tests.lock()
    return {"locked": True}


@app.post("/api/feature-tests/open")
async def feature_tests_open(body: FeatureTestOpenIn):
    return await S().feature_tests.open_build(body.pr)


# ---------------------------------------------------------------- UI
@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
