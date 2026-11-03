"""CliDriver process handling, using a fake `pymobiledevice3` that behaves like the real CLI."""

import asyncio
import json
import sys
import textwrap

import pytest

from spoofer.device import cli

FAKE = textwrap.dedent(
    """
    import json, sys, signal
    args = sys.argv[1:]
    log = open(sys.argv[0] + ".log", "a")
    log.write(json.dumps(args) + "\\n"); log.close()
    if args[:2] == ["usbmux", "list"]:
        print(json.dumps([{"Identifier": "U1", "DeviceName": "Test", "ProductVersion": "18.1"}]))
    elif "set" in args or "play" in args:
        if "--fail" in args:
            print("2026-01-01 00:00:00 host __main__[1] ERROR DeveloperModeIsNotEnabledError"); sys.exit(1)
        sys.stdout.write("Press ENTER to exit>"); sys.stdout.flush()
        try:
            input()
        except (EOFError, KeyboardInterrupt):
            pass
    """
)


@pytest.fixture()
def fake(tmp_path, monkeypatch):
    script = tmp_path / "fake_pmd3.py"
    script.write_text(FAKE)
    monkeypatch.setattr(cli, "_base_cmd", lambda: [sys.executable, str(script)])
    return tmp_path / "fake_pmd3.py.log"


def calls(log):
    return [json.loads(line) for line in log.read_text().splitlines()]


def test_connect_set_clear(fake):
    async def run():
        d = cli.CliDriver()
        info = await d.connect()
        assert info.name == "Test" and d._dvt
        await d.set_location(1.5, 2.5)
        assert d._held is not None and d._held.running
        first = d._held
        await d.set_location(3.0, 4.0)  # replaces the previous process
        assert first.proc.returncode is not None
        await d.clear_location()
        assert d._held is None
        await d.disconnect()

    asyncio.run(run())
    c = calls(fake)
    assert c[1][:4] == ["developer", "dvt", "simulate-location", "set"]
    assert c[1][-3:] == ["--", "1.5000000", "2.5000000"]
    assert "--udid" in c[1] and "U1" in c[1]
    assert c[-1][:4] == ["developer", "dvt", "simulate-location", "clear"]


def test_set_failure_reports_error(fake, monkeypatch):
    async def run():
        d = cli.CliDriver()
        await d.connect()
        monkeypatch.setattr(d, "_udid_args", lambda: ["--fail"])
        with pytest.raises(cli.DeviceError, match="DeveloperModeIsNotEnabledError"):
            await d.set_location(1, 2)

    asyncio.run(run())
