"""Import and organize copies, keeping the source read-only."""

import argparse
import json

from wildstring.config import Settings
from wildstring.library.importer import import_music
from wildstring.library.scanner import ScanBusyError


def main() -> int:
    parser = argparse.ArgumentParser(description="Copy music into the managed library, then scan")
    parser.add_argument("--full", action="store_true", help="Refresh all tags after importing")
    arguments = parser.parse_args()
    try:
        result = import_music(Settings(), full=arguments.full)
    except ScanBusyError:
        print(json.dumps({"error": "library_busy"}))
        return 3
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return {"completed": 0, "completed_with_errors": 2, "failed": 1}[result["status"]]


if __name__ == "__main__":
    raise SystemExit(main())
