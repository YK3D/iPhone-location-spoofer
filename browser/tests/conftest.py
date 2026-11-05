import pytest

from spoofer import routing


@pytest.fixture(autouse=True)
def _no_osrm_throttle(monkeypatch):
    """The 1 request/second limit for the public OSRM server only slows tests down."""
    monkeypatch.setattr(routing, "OSRM_MIN_INTERVAL_S", 0.0)
    routing._cache.clear()
