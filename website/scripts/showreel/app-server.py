"""The browser edition, started for the showreel recorder with a clock it can pause and step.

The recorder captures the app one video frame at a time: it stops the page's clock, moves it on by
1/30 s, takes a screenshot, and repeats. Playback and the joystick run on the server, so the
server's clock has to move in the same steps, or the iPhone would travel as far per frame as the
screenshot took in real time. This wraps the app's own server, unchanged, in an asyncio event loop
whose clock the recorder controls through one extra endpoint:

    POST /__showreel/clock {"action": "pause"}            stop the clock where it is
    POST /__showreel/clock {"action": "step", "dt": 0.033} move it on, and let what was due run
    POST /__showreel/clock {"action": "resume"}           run in real time again from there

While the clock is paused, timers (playback ticks, the router's one-request-a-second limit) only
fire when it is stepped; network requests still complete in real time.

    SPOOFER_DATA_DIR=$(mktemp -d) python website/scripts/showreel/app-server.py --port 8766
"""
from __future__ import annotations

import argparse
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "browser"))

import uvicorn  # noqa: E402
from fastapi import Body  # noqa: E402

from spoofer import __version__  # noqa: E402
from spoofer.server import app  # noqa: E402


class Clock:
    def __init__(self) -> None:
        self.offset = 0.0
        self.paused_at: float | None = None

    def now(self) -> float:
        return self.paused_at if self.paused_at is not None else time.monotonic() + self.offset


clock = Clock()


class SteppedLoop(asyncio.SelectorEventLoop):
    def time(self) -> float:  # every asyncio timer (sleep, call_later, timeouts) reads this
        return clock.now()


@app.post("/__showreel/clock")
async def showreel_clock(action: str = Body(...), dt: float = Body(0.0)):
    if action == "pause" and clock.paused_at is None:
        clock.paused_at = clock.now()
    elif action == "step" and clock.paused_at is not None:
        clock.paused_at += max(0.0, dt)
        # let timers that are now due run, and what they wake up, before answering
        for _ in range(6):
            await asyncio.sleep(0)
    elif action == "resume" and clock.paused_at is not None:
        clock.offset = clock.paused_at - time.monotonic()
        clock.paused_at = None
    return {"t": clock.now(), "paused": clock.paused_at is not None}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8766)
    args = ap.parse_args()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=args.port, log_level="warning"))
    app.state.server = server
    print(f"Location Spoofer {__version__} for the showreel recorder: http://127.0.0.1:{args.port}/", flush=True)
    asyncio.run(server.serve(), loop_factory=SteppedLoop)


if __name__ == "__main__":
    main()
