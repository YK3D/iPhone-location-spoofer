"""Plays a timeline (or a joystick) onto the connected device."""

from __future__ import annotations

import asyncio
import logging
import os
import random
import tempfile
import time
from dataclasses import dataclass, field
from typing import Optional

from . import geo
from .device.base import DeviceDriver, DeviceError
from .gpx_io import write_gpx
from .profile import Timeline

log = logging.getLogger(__name__)


@dataclass
class Position:
    lat: float
    lon: float
    speed_ms: float = 0.0
    course: float = 0.0
    sent_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {
            "lat": self.lat,
            "lon": self.lon,
            "speed_kmh": round(self.speed_ms * 3.6, 2),
            "course": round(self.course, 1),
            "sent_at": self.sent_at,
        }


class Player:
    """States: idle, playing, paused, held (stopped at a "hold until Continue" checkpoint),
    finished, joystick, error."""

    def __init__(self, get_driver) -> None:
        self._get_driver = get_driver
        self.timeline: Optional[Timeline] = None
        self.timeline_name = ""
        self.state = "idle"
        self.t = 0.0
        self.direction = 1
        self.multiplier = 1.0
        self.loop = "once"  # once | loop | pingpong
        self.jitter_m = 0.0
        self.tick_s = 1.0
        self.laps = 0  # one-way trips completed (a round trip in back-and-forth mode is two)
        self.lap_limit = 0  # laps to drive in loop / back-and-forth mode; 0 = no limit
        self.held_at: Optional[int] = None  # waypoint index while held
        self.position: Optional[Position] = None
        self.error: Optional[str] = None
        self._task: Optional[asyncio.Task] = None
        self._gpx_path: Optional[str] = None
        self._rng = random.Random()
        # joystick
        self.joy_bearing = 0.0
        self.joy_speed_kmh = 5.0
        self.joy_moving = False

    @property
    def driver(self) -> DeviceDriver:
        return self._get_driver()

    # ------------------------------------------------------------------ public API
    def status(self) -> dict:
        tl = self.timeline
        return {
            "state": self.state,
            "t": round(self.t, 2),
            "duration": round(tl.duration, 2) if tl else 0.0,
            "distance_m": round(tl.at(self.t).distance_m, 1) if tl else 0.0,
            "total_distance_m": round(tl.distance, 1) if tl else 0.0,
            "name": self.timeline_name,
            "multiplier": self.multiplier,
            "loop": self.loop,
            "jitter_m": self.jitter_m,
            "tick_s": self.tick_s,
            "laps": self.laps,
            "lap": self.current_lap(),
            "lap_limit": self.lap_limit,
            "held_at": self.held_at,
            "holds": [[round(h, 2), i] for h, i in tl.holds] if tl else [],
            "direction": self.direction,
            "position": self.position.to_dict() if self.position else None,
            "error": self.error,
            "joystick": {"bearing": self.joy_bearing, "speed_kmh": self.joy_speed_kmh, "moving": self.joy_moving},
        }

    def current_lap(self) -> int:
        """The lap being driven, from 1 (a round trip counts once in back-and-forth mode)."""
        return self.laps // 2 + 1 if self.loop == "pingpong" else self.laps + 1

    def _laps_done(self) -> bool:
        if self.lap_limit <= 0 or self.loop == "once":
            return False
        return self.laps >= (2 * self.lap_limit if self.loop == "pingpong" else self.lap_limit)

    async def load(self, timeline: Timeline, name: str) -> None:
        await self.stop()
        self.timeline = timeline
        self.timeline_name = name
        self.t = 0.0
        self.direction = 1
        self.laps = 0
        self.held_at = None
        self.state = "idle"

    async def play(self) -> None:
        if self.timeline is None:
            raise DeviceError("Build or import a route first")
        self._require_driver()
        # A finished route plays again from the start; leaving a hold on the last checkpoint
        # carries on with the end of the route (next lap or finish) instead.
        if self.state == "finished" or (self.state != "held" and self.t >= self.timeline.duration and self.direction > 0):
            self.t = 0.0
            self.direction = 1
            self.laps = 0
        await self._cancel_task()
        self.held_at = None
        self.error = None
        self.state = "playing"
        self._task = asyncio.create_task(self._run_timeline())

    async def pause(self) -> None:
        if self.state != "playing":
            return
        await self._cancel_task()
        self.state = "paused"
        if not self.driver.live:
            await self.driver.stop_gpx()
            if self.position:
                await self._send(self.position.lat, self.position.lon, jitter=False)

    async def resume(self) -> None:
        if self.state in ("paused", "held"):
            await self.play()

    async def continue_(self) -> None:
        """Leave a "hold until Continue" checkpoint."""
        if self.state == "held":
            await self.play()

    async def stop(self) -> None:
        await self._cancel_task()
        if not self.driver.live:
            try:
                await self.driver.stop_gpx()
            except Exception:
                pass
        if self.state in ("playing", "paused", "held", "joystick", "finished"):
            self.state = "idle"
        self.held_at = None
        self.joy_moving = False

    async def unload(self) -> None:
        """Forget the loaded route (e.g. after the user cleared it)."""
        await self.stop()
        self.timeline = None
        self.timeline_name = ""
        self.t = 0.0
        self.direction = 1
        self.laps = 0
        self.held_at = None
        if self.state not in ("joystick",):
            self.state = "idle"

    async def seek(self, t: float) -> None:
        if self.timeline is None:
            return
        self.t = min(max(t, 0.0), self.timeline.duration)
        p = self.timeline.at(self.t)
        self.position = Position(p.lat, p.lon, p.speed_ms, p.course)
        if self.state == "held":  # moving away from a hold releases it
            self.held_at = None
            self.state = "paused"
        if self.state == "playing" and not self.driver.live:
            await self.play()  # restart the GPX from the new offset
        elif self.state in ("paused", "idle", "finished") and self.driver.connected:
            await self._send(p.lat, p.lon, p.speed_ms, p.course, jitter=False)

    async def set_options(self, multiplier=None, loop=None, jitter_m=None, tick_s=None, lap_limit=None) -> None:
        restart = False
        if lap_limit is not None:
            if not 0 <= lap_limit <= 100_000:
                raise ValueError("Laps must be between 0 (no limit) and 100000")
            self.lap_limit = int(lap_limit)
        if multiplier is not None:
            if not 0.05 <= multiplier <= 100:
                raise ValueError("Speed multiplier must be between 0.05 and 100")
            restart = restart or multiplier != self.multiplier
            self.multiplier = float(multiplier)
        if loop is not None:
            if loop not in ("once", "loop", "pingpong"):
                raise ValueError("loop must be once, loop or pingpong")
            self.loop = loop
        if jitter_m is not None:
            if not 0 <= jitter_m <= 100:
                raise ValueError("Jitter must be between 0 and 100 m")
            self.jitter_m = float(jitter_m)
        if tick_s is not None:
            if not 0.2 <= tick_s <= 10:
                raise ValueError("Update interval must be between 0.2 and 10 s")
            restart = restart or tick_s != self.tick_s
            self.tick_s = float(tick_s)
        if restart and self.state == "playing" and not self.driver.live:
            await self.play()

    async def teleport(self, lat: float, lon: float) -> dict:
        geo.validate_latlon(lat, lon)
        self._require_driver()
        prev = self.position
        await self.stop()
        await self._send(lat, lon, jitter=False)
        out = {"lat": lat, "lon": lon}
        if prev is not None:
            out["jump_m"] = round(geo.haversine_m((prev.lat, prev.lon), (lat, lon)), 1)
            out["seconds_since_last"] = round(time.time() - prev.sent_at, 1)
        return out

    async def clear(self) -> None:
        await self.stop()
        self._require_driver(connected=True)
        await self.driver.clear_location()
        self.position = None

    async def joystick(self, moving: bool, bearing: Optional[float] = None, speed_kmh: Optional[float] = None) -> None:
        self._require_driver()
        if not self.driver.live:
            raise DeviceError("The joystick needs the Direct connection method (the CLI method is too slow).")
        if self.position is None:
            raise DeviceError("Set a starting location first (click the map and press Teleport)")
        if bearing is not None:
            self.joy_bearing = float(bearing) % 360
        if speed_kmh is not None:
            if not 0 < speed_kmh <= 1000:
                raise ValueError("Joystick speed must be between 0 and 1000 km/h")
            self.joy_speed_kmh = float(speed_kmh)
        self.joy_moving = bool(moving)
        if self.state != "joystick":
            await self._cancel_task()
            self.state = "joystick"
            self._task = asyncio.create_task(self._run_joystick())

    def effective_tick(self) -> float:
        """Seconds between location updates. At high time speeds the interval shrinks (down to
        0.25 s) so each update still moves the device about as far as at 1x, instead of jumping."""
        return max(0.25, self.tick_s / max(1.0, self.multiplier)) if self.multiplier > 1 else self.tick_s

    # ------------------------------------------------------------------ internals
    def _require_driver(self, connected: bool = True) -> None:
        if connected and not self.driver.connected:
            raise DeviceError("No device connected. Connect your iPhone (or the Simulator) first.")

    async def _cancel_task(self) -> None:
        task, self._task = self._task, None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    async def _send(self, lat: float, lon: float, speed: float = 0.0, course: float = 0.0, jitter: bool = True) -> None:
        if jitter and self.jitter_m > 0:
            lat, lon = geo.jitter((lat, lon), self.jitter_m, self._rng)
        await self.driver.set_location(lat, lon)
        self.position = Position(lat, lon, speed, course)

    async def _run_timeline(self) -> None:
        try:
            if self.driver.live:
                await self._run_live()
            else:
                await self._run_gpx()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.exception("playback failed")
            self.error = str(e)
            self.state = "error"

    def _hold(self, h: float, index: int) -> None:
        self.t = h
        self.held_at = index
        self.state = "held"

    async def _run_live(self) -> None:
        tl = self.timeline
        assert tl is not None
        loop = asyncio.get_running_loop()
        last = loop.time()
        while True:
            p = tl.at(self.t)
            await self._send(p.lat, p.lon, p.speed_ms, p.course if self.direction > 0 else (p.course + 180) % 360)
            if self.state == "held":
                return  # the device waits at the checkpoint until Continue
            # end handling
            at_end = self.t >= tl.duration if self.direction > 0 else self.t <= 0
            if at_end:
                if self.loop == "once" or tl.duration <= 0:
                    self.state = "finished"
                    return
                self.laps += 1
                if self._laps_done():
                    self.state = "finished"
                    return
                if self.loop == "loop":
                    self.t = 0.0
                    first = tl.holds[0] if tl.holds and tl.holds[0][0] <= 1e-9 else None
                    if first:  # a new lap starts at a hold on the first checkpoint
                        self._hold(*first)
                        continue
                else:
                    self.direction = -self.direction
            await asyncio.sleep(self.effective_tick())
            now = loop.time()
            dt = (now - last) * self.multiplier
            last = now
            new_t = min(max(self.t + dt * self.direction, 0.0), tl.duration)
            hold = tl.next_hold(self.t, self.direction)
            if hold and (hold[0] <= new_t + 1e-9 if self.direction > 0 else hold[0] >= new_t - 1e-9):
                self._hold(*hold)  # stop exactly on the checkpoint, not past it
            else:
                self.t = new_t

    async def _run_gpx(self) -> None:
        """Non-live driver: hand the remaining route to `simulate-location play`, track progress by clock."""
        tl = self.timeline
        assert tl is not None
        loop = asyncio.get_running_loop()
        while True:
            start_t = self.t
            hold = tl.next_hold(start_t)
            end_t = hold[0] if hold else tl.duration
            samples = tl.sample(self.tick_s * self.multiplier, start=start_t, end=end_t)
            for s in samples:  # rebase to 0 and apply the speed multiplier
                s.t = (s.t - start_t) / self.multiplier
            self._write_gpx(samples)
            await self.driver.play_gpx(self._gpx_path)  # type: ignore[arg-type]
            t0 = loop.time()
            while self.t < end_t:
                await asyncio.sleep(0.5)
                self.t = min(start_t + (loop.time() - t0) * self.multiplier, end_t)
                p = tl.at(self.t)
                self.position = Position(p.lat, p.lon, p.speed_ms, p.course)
            if hold:
                self._hold(*hold)  # the GPX ends on the checkpoint; Continue plays the rest
                return
            await asyncio.sleep(self.tick_s)
            if self.loop == "once":
                self.state = "finished"
                return
            self.laps += 1
            if self._laps_done():
                self.state = "finished"
                return
            self.t = 0.0  # ping-pong is treated as loop in this mode

    def _write_gpx(self, samples) -> None:
        if self._gpx_path is None:
            fd, path = tempfile.mkstemp(prefix="spoofer-", suffix=".gpx")
            os.close(fd)
            self._gpx_path = path
        with open(self._gpx_path, "w", encoding="utf-8") as f:
            f.write(write_gpx(samples, name=self.timeline_name or "Route"))

    async def _run_joystick(self) -> None:
        loop = asyncio.get_running_loop()
        last = loop.time()
        tick = min(self.tick_s, 0.5)
        try:
            while True:
                await asyncio.sleep(tick)
                now = loop.time()
                dt, last = now - last, now
                if self.position is None:
                    continue
                if self.joy_moving:
                    dist = self.joy_speed_kmh / 3.6 * dt
                    lat, lon = geo.destination((self.position.lat, self.position.lon), self.joy_bearing, dist)
                    await self.driver.set_location(lat, lon)
                    self.position = Position(lat, lon, self.joy_speed_kmh / 3.6, self.joy_bearing)
                elif now - self.position.sent_at > 5:
                    # keep-alive so apps polling for updates still see a fresh fix
                    await self.driver.set_location(self.position.lat, self.position.lon)
                    self.position = Position(self.position.lat, self.position.lon, 0.0, self.joy_bearing)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.exception("joystick failed")
            self.error = str(e)
            self.state = "error"
