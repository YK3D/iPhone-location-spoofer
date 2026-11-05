"""Location Spoofer, browser edition - a local map app that drives pymobiledevice3.

Copyright (c) 2026 YK3D. Licensed under the GNU GPL v3 or later with additional
attribution terms (section 7): see browser/LICENSE and browser/NOTICE.
"""

from ._build import BUILD_VERSION

# Source checkouts report a "-dev" version; release builds get the CI build number.
__version__ = BUILD_VERSION or "1.3.0-dev"
