"""Run one scan without starting the web server."""

import argparse
import json

from wildstring.config import Settings
from wildstring.library.scanner import ScanBusyError, scan_library


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only local music library scan")
    parser.add_argument(
        "--full", action="store_true", help="Read tags even when size and mtime match"
    )
    arguments = parser.parse_args()
    try:
        result = scan_library(Settings(), full=arguments.full)
    except ScanBusyError:
        print(json.dumps({"error": "scan_already_running"}))
        return 3
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return {"completed": 0, "completed_with_errors": 2, "failed": 1}[result["status"]]


if __name__ == "__main__":
    raise SystemExit(main())
