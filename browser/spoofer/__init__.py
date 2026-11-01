"""iPhone Location Spoofer - a local map app that drives pymobiledevice3."""

from ._build import BUILD_VERSION

# Source checkouts report a "-dev" version; release builds get the CI build number.
__version__ = BUILD_VERSION or "1.3.0-dev"
