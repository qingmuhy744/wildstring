"""Probe readiness from Make, Docker, and CI."""

import argparse
import json
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import urlopen

from wildstring.config import Settings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url")
    arguments = parser.parse_args()
    settings = Settings()
    url = arguments.url or f"http://127.0.0.1:{settings.port}/health/ready"
    if urlsplit(url).scheme not in {"http", "https"}:
        parser.error("Health URL must use HTTP or HTTPS")
    try:
        # The URL scheme is checked above; this probe never opens local files.
        with urlopen(url, timeout=5) as response:  # nosec B310
            result = json.load(response)
        if result.get("status") != "ok":
            print("WildString is not ready")
            return 1
    except (HTTPError, URLError, TimeoutError, ValueError, OSError):
        print("WildString health check failed")
        return 1
    print("WildString is ready")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
