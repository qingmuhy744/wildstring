#!/usr/bin/env python3
"""Report which CI areas a change touches, for GitHub Actions job outputs.

Filtering out an entire workflow can leave a required check pending. Workflows that report
required checks start for every PR and decide which suites to run after inspecting the diff.
Unknown inputs run the backend, Web and Android checks until classified here.

Usage: ci_changed_areas.py BASE HEAD     # prints one boolean per validation area
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
    ".github/pull_request_template.md",
    "CHANGELOG.md",
    "DESIGN.md",
    "AGENTS.md",
    "README.md",
    "README.en.md",
    "LICENSE",
)

# `scripts/` and `plugins/` feed backend tests, including the containerized backend suite.
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

# What the Android job builds and tests: the Gradle project, the audio fixtures packed into
# instrumented tests, the packaging script, and what the emulator and release runs reuse.
ANDROID = (
    "frontend/android/",
    "tests/fixtures/audio/",
    "backend/",
    "scripts/package_android.py",
    "scripts/retry_on_429.sh",
    "scripts/serve_web_tests.py",
    "scripts/smoke_android_release.py",
    "Makefile",
    ".github/workflows/android.yml",
    ".github/workflows/release.yml",
)
MACOS = (
    "frontend/macos/",
    "frontend/apple-shared/",
    "frontend/ios/WildStringKit/",
    "scripts/package_macos_dmg.sh",
    ".github/workflows/macos.yml",
    "Makefile",
)
IOS = ("frontend/ios/", "frontend/apple-shared/", ".github/workflows/ios.yml", "Makefile")


def changed_files(base: str, head: str) -> list[str]:
    result = subprocess.run(  # nosec B603 B607
        ["git", "diff", "--no-renames", "--name-only", f"{base}...{head}"],
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


def touches_android(files: list[str]) -> bool:
    # `frontend/android/` is inert for the other areas, so Android checks its own inputs first.
    for name in files:
        if name.startswith(ANDROID):
            return True
        if not name.startswith(INERT + BACKEND + WEB):
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
        for area in ("backend", "web", "android", "container", "macos", "ios"):
            print(f"{area}=true")
        return 0
    backend = touches(files, BACKEND)
    selected = {
        "backend": backend,
        "web": touches(files, WEB),
        "android": touches_android(files),
        "container": backend or any(name.startswith("frontend/web/") for name in files),
        "macos": any(name.startswith(MACOS) for name in files),
        "ios": any(name.startswith(IOS) for name in files),
    }
    for area, needed in selected.items():
        print(f"{area}={str(needed).lower()}")
    print(f"{len(files)} changed files", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
