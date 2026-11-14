#!/usr/bin/env python3
"""Report which CI areas a change touches, for GitHub Actions job outputs.

Every check on `main` is required, and GitHub leaves a *skipped job* pending forever. The
workflows therefore keep each required job and skip only its expensive steps when this script
says its inputs are untouched. Anything unknown counts as touching everything, so a new
top-level directory is tested until it is classified here.

Usage: ci_changed_areas.py BASE HEAD     # prints `backend=true|false` and `web=true|false`
Pushes to main, tags, manual runs and release reuse never call this and run everything.
"""

from __future__ import annotations

import subprocess  # nosec B404
import sys

# Changes that can never affect backend or Web behaviour.
INERT = (
    "frontend/android/",
    "frontend/apple-shared/",
    "frontend/ios/",
    "frontend/macos/",
    "docs/",
    "contracts/",
    "assets/",
    ".agents/",
    ".github/workflows/android.yml",
    ".github/workflows/ios.yml",
    ".github/workflows/macos.yml",
    ".github/workflows/codeql.yml",
    ".github/workflows/dependency-review.yml",
    ".github/workflows/dependency-submission.yml",
    "CHANGELOG.md",
    "DESIGN.md",
    "AGENTS.md",
    "README.md",
    "README.en.md",
    "LICENSE",
)

# Files the backend suite and the container build read. `scripts/` and `plugins/` feed backend
# tests; `deploy/` and the lockfile feed the container.
BACKEND = (
    "backend/",
    "scripts/",
    "plugins/",
    "tests/",
    "deploy/",
    "Makefile",
    ".python-version",
    ".github/workflows/ci.yml",
    ".pre-commit-config.yaml",
)

# The Web build, its Playwright suites, and the synthetic API they run against.
WEB = (
    "frontend/web/",
    "backend/",
    "scripts/",
    "plugins/",
    "tests/",
    "Makefile",
    ".nvmrc",
    ".github/workflows/ci.yml",
)


def changed_files(base: str, head: str) -> list[str]:
    result = subprocess.run(  # nosec B603 B607
        ["git", "diff", "--name-only", f"{base}...{head}"],
        check=True,
        capture_output=True,
        text=True,
    )
    return [line for line in result.stdout.splitlines() if line]


def touches(files: list[str], prefixes: tuple[str, ...]) -> bool:
    for name in files:
        if name.startswith(INERT):
            continue
        if name.startswith(prefixes):
            return True
        # Not inert and not claimed by this area: only top-level files and directories this
        # script does not know are treated as touching the area.
        if not name.startswith(BACKEND + WEB):
            return True
    return False


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    try:
        files = changed_files(argv[1], argv[2])
    except subprocess.CalledProcessError as error:
        # An unreadable diff must never hide tests.
        print(f"git diff failed ({error.returncode}); running everything", file=sys.stderr)
        files = ["?unknown"]
    backend = touches(files, BACKEND)
    web = touches(files, WEB)
    for line in (f"backend={str(backend).lower()}", f"web={str(web).lower()}"):
        print(line)
    print(f"{len(files)} changed files", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
