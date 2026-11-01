"""Entry point.

From source: ``py -3.12 -m spoofer`` (Windows) or ``python3 -m spoofer``.
As the Windows build: ``LocationSpoofer.exe``.

Special first arguments (used internally by the .exe):
  pmd3-cli ...   run the bundled pymobiledevice3 command line
  --self-test    check the build contains everything it needs, then exit
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import threading
import time
import webbrowser


def _run_pmd3_cli(args: list[str]) -> int:
    from pymobiledevice3.__main__ import main as pmd3_main

    sys.argv = ["pymobiledevice3", *args]
    try:
        rc = pmd3_main()
    except SystemExit as e:  # typer exits with the command's status
        return e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    return int(rc or 0)


def _wait_for_pid(pid: int, timeout: float = 30.0) -> None:
    try:
        import psutil
    except ImportError:
        time.sleep(3)
        return
    deadline = time.time() + timeout
    while time.time() < deadline and psutil.pid_exists(pid):
        time.sleep(0.2)


def _already_running(host: str, port: int) -> bool:
    import httpx

    try:
        r = httpx.get(f"http://{host}:{port}/api/status", timeout=1.5)
        return r.status_code == 200 and "player" in r.json()
    except Exception:
        return False


def _self_test() -> int:
    """Import and exercise everything the .exe needs; CI refuses to publish a build that fails."""
    import subprocess
    from pathlib import Path

    from spoofer import __version__, geo, routing, server
    from spoofer.helpers import pmd3_command
    from spoofer.profile import Leg, ProfileSettings, Waypoint, build_timeline

    checks = []
    static = Path(server.STATIC)
    checks.append(("static files", (static / "index.html").is_file() and (static / "app.js").is_file()))

    import pymobiledevice3.remote.userspace_tunnel  # noqa: F401
    import pymobiledevice3.services.amfi  # noqa: F401
    import pymobiledevice3.services.dvt.instruments.location_simulation  # noqa: F401
    import pymobiledevice3.services.mobile_image_mounter  # noqa: F401
    import pymobiledevice3.services.simulate_location  # noqa: F401
    import pymobiledevice3.tunneld.api  # noqa: F401

    checks.append(("pymobiledevice3 API", True))

    pts = routing._sea_route((49.49, 0.10), (50.9, 1.8))
    checks.append(("sea routing data", len(pts) > 2))

    a, b = (51.5, -0.12), geo.destination((51.5, -0.12), 90, 500)
    tl = build_timeline([Waypoint(*a), Waypoint(*b)], [Leg([a, b])], ProfileSettings())
    checks.append(("speed profile", tl.duration > 0))

    out = subprocess.run(
        pmd3_command() + ["developer", "dvt", "simulate-location", "set", "--help"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180,
    )
    checks.append(("pymobiledevice3 CLI", out.returncode == 0 and "latitude" in out.stdout.lower()))

    ok = all(v for _, v in checks)
    print(f"LocationSpoofer {__version__} self-test")
    for name, v in checks:
        print(f"  {'OK  ' if v else 'FAIL'} {name}")
    if not checks[-1][1]:
        print(out.stdout[-2000:], out.stderr[-2000:])
    return 0 if ok else 1


def main() -> None:
    # Fast paths that must not start the web app
    if len(sys.argv) > 1 and sys.argv[1] == "pmd3-cli":
        sys.exit(_run_pmd3_cli(sys.argv[2:]))

    ap = argparse.ArgumentParser(prog="LocationSpoofer", description="iPhone Location Spoofer")
    ap.add_argument("--host", default="127.0.0.1", help="interface to listen on (default: this computer only)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true", help="do not open the browser automatically")
    ap.add_argument("--no-update", action="store_true", help="do not check GitHub for updates")
    ap.add_argument("--debug", action="store_true")
    ap.add_argument("--version", action="store_true")
    ap.add_argument("--self-test", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--wait-pid", type=int, help=argparse.SUPPRESS)
    args = ap.parse_args()

    from spoofer import __version__

    if args.version:
        print(__version__)
        return
    if args.self_test:
        sys.exit(_self_test())

    logging.basicConfig(level=logging.DEBUG if args.debug else logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    if not args.debug:
        logging.getLogger("httpx").setLevel(logging.WARNING)
    if args.wait_pid:
        _wait_for_pid(args.wait_pid)

    from spoofer.updater import Updater

    updater = Updater()
    if args.no_update:
        updater.enabled = False
        updater.state = "disabled"
    if updater.enabled and updater.swap_in_staged():
        # An update finished downloading last time: start the new version instead.
        print("  Installing update and restarting...")
        updater.relaunch(sys.argv[1:])
        return
    if updater.enabled:
        threading.Thread(target=updater.cleanup_old, daemon=True).start()

    browse_host = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
    url = f"http://{browse_host}:{args.port}/"
    if _already_running(browse_host, args.port):
        print(f"  Already running - opening {url}")
        if not args.no_browser:
            webbrowser.open(url)
        return

    import uvicorn

    from spoofer.server import app

    app.state.s.updater = updater
    updater.channel_getter = lambda: (app.state.s.store.load().get("settings") or {}).get("update_channel", "stable")
    server = uvicorn.Server(uvicorn.Config(app, host=args.host, port=args.port, log_level="warning"))
    app.state.server = server
    if not args.no_browser:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    print(f"\n  iPhone Location Spoofer {__version__} is running at {url}\n  Keep this window open. Close it (or press Ctrl+C) to quit.\n")
    server.run()

    if getattr(app.state, "restart_requested", False):
        # Restart-to-update: the server has stopped, start the freshly swapped-in exe.
        updater.relaunch([a for a in sys.argv[1:] if a != "--no-browser"] + ["--no-browser"])
        os._exit(0)


if __name__ == "__main__":
    main()
