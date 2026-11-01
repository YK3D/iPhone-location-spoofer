"""Process helpers shared by the source and .exe builds."""

from __future__ import annotations

import subprocess
import sys

from .updater import is_frozen

PMD3_CLI_ARG = "pmd3-cli"


def pmd3_command() -> list[str]:
    """Command prefix that runs the pymobiledevice3 CLI.

    From source: ``python -m pymobiledevice3``. In the .exe there is no separate Python, so the
    exe runs the bundled CLI itself when its first argument is ``pmd3-cli``.
    """
    if is_frozen():
        return [sys.executable, PMD3_CLI_ARG]
    return [sys.executable, "-m", "pymobiledevice3"]


def start_tunneld_elevated() -> str:
    """Open the pymobiledevice3 tunnel helper in its own window, as administrator.

    Needed only for iOS 17.0-17.3; newer iOS uses the no-admin userspace tunnel.
    """
    cmd = pmd3_command() + ["remote", "tunneld"]
    if sys.platform == "win32":
        import ctypes
        import os

        params = subprocess.list2cmdline(cmd[1:])
        # The helper must outlive this app's unpack folder, so it starts as an independent instance.
        old = os.environ.get("PYINSTALLER_RESET_ENVIRONMENT")
        os.environ["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
        try:
            # ShellExecuteW returns a value > 32 on success; "runas" shows the UAC prompt.
            rc = ctypes.windll.shell32.ShellExecuteW(None, "runas", cmd[0], params, None, 1)  # type: ignore[attr-defined]
        finally:
            if old is None:
                os.environ.pop("PYINSTALLER_RESET_ENVIRONMENT", None)
            else:
                os.environ["PYINSTALLER_RESET_ENVIRONMENT"] = old
        if rc <= 32:
            raise RuntimeError("Windows did not start the tunnel helper (administrator permission refused?)")
        return "Tunnel helper started in a new window. Keep it open, then press Connect."
    return "Run this in a terminal and keep it open: sudo " + subprocess.list2cmdline(cmd)
