#!/usr/bin/env sh
# iPhone Location Spoofer - macOS / Linux launcher
set -e
cd "$(dirname "$0")"
PY="${PYTHON:-python3}"
[ -x .venv/bin/python ] || "$PY" -m venv .venv
.venv/bin/python -m pip install --disable-pip-version-check -q -r requirements.txt
exec .venv/bin/python -m spoofer "$@"
