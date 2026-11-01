"""Start the app: `py -3.12 -m spoofer` (Windows) or `python3 -m spoofer`."""

from __future__ import annotations

import argparse
import logging
import threading
import webbrowser


def main() -> None:
    ap = argparse.ArgumentParser(description="iPhone Location Spoofer")
    ap.add_argument("--host", default="127.0.0.1", help="interface to listen on (default: this computer only)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true", help="do not open the browser automatically")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.debug else logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    import uvicorn

    url = f"http://{'127.0.0.1' if args.host in ('0.0.0.0', '::') else args.host}:{args.port}/"
    if not args.no_browser:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    print(f"\n  iPhone Location Spoofer is running at {url}\n  Keep this window open. Press Ctrl+C to quit.\n")
    uvicorn.run("spoofer.server:app", host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
