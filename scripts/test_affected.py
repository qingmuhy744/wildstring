#!/usr/bin/env python3
"""Detects and runs backend and Web E2E tests affected by current git changes.

Why this exists:
- `make check` is fast but runs zero functional tests.
- `make ci` runs all 40+ Playwright specs across 8 server configurations and takes a long time.
- When UI copy, i18n strings, components, or backend modules change, unrelated test files
  often still assert old text or old selectors and only fail later on GitHub Actions.

Usage:
  python scripts/test_affected.py --scan-only   # Fast (<1s) report of stale assertions & affected specs
  python scripts/test_affected.py --run         # Run the affected backend pytest & Web Playwright specs
  make test-affected                            # Wrapper for --run
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess  # nosec B404
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB_TESTS_DIR = ROOT / "frontend/web/tests"
BACKEND_TESTS_DIR = ROOT / "backend/tests"

# Special Playwright environment groups mirroring Makefile targets
SPECIAL_WEB_ENVS: dict[str, dict[str, str]] = {
    "podcast-publishers.spec.ts": {
        "WILDSTRING_TEST_PODCAST": "1",
        "WILDSTRING_TEST_PUBLISHERS": "1",
    },
    "music-libraries.spec.ts": {
        "WILDSTRING_TEST_LIBRARIES": "1",
        "WILDSTRING_TEST_PODCAST": "1",
    },
    "podcast-continuation.spec.ts": {"WILDSTRING_TEST_PODCAST": "1"},
    "podcast-player.spec.ts": {"WILDSTRING_TEST_PODCAST": "1"},
    "podcast-episode.spec.ts": {"WILDSTRING_TEST_PODCAST": "1"},
    "podcast-progress.spec.ts": {"WILDSTRING_TEST_PODCAST": "1"},
    "personal-settings.spec.ts": {"WILDSTRING_TEST_PODCAST": "1"},
    "podcast-search.spec.ts": {"WILDSTRING_TEST_PODCAST": "1"},
    "podcast-search-settings.spec.ts": {"WILDSTRING_TEST_PODCAST": "1"},
    "podcast-opml.spec.ts": {"WILDSTRING_TEST_PODCAST": "1"},
    "podcast-identity-admin.spec.ts": {"WILDSTRING_TEST_PODCAST": "1"},
    "multipage-real.spec.ts": {"WILDSTRING_TEST_LARGE_LIBRARY": "1"},
    "browse-real.spec.ts": {"WILDSTRING_TEST_BROWSE_LIBRARY": "1"},
    "catalog-sort-real.spec.ts": {"WILDSTRING_TEST_DISC_LIBRARY": "1"},
    "transcoding.spec.ts": {"WILDSTRING_TEST_TRANSCODING": "1"},
}

# Mapping from Web source file stems to primary Playwright specs
WEB_COMPONENT_TO_SPECS: dict[str, list[str]] = {
    "offline-panel": ["playlist-offline.spec.ts", "completion.spec.ts"],
    "personal-settings": [
        "personal-settings.spec.ts",
        "settings-navigation.spec.ts",
        "playlist-offline.spec.ts",
        "i18n.spec.ts",
    ],
    "management": [
        "management.spec.ts",
        "settings-navigation.spec.ts",
        "podcast-identity-admin.spec.ts",
        "podcast-search-settings.spec.ts",
        "music-libraries.spec.ts",
    ],
    "podcast-programmes-admin": [
        "podcast-identity-admin.spec.ts",
        "podcast-opml.spec.ts",
        "podcast-search.spec.ts",
    ],
    "library": [
        "collections.spec.ts",
        "song-album.spec.ts",
        "browse-real.spec.ts",
        "catalog-sort-real.spec.ts",
        "track-availability.spec.ts",
    ],
    "discover": ["recommendations-unified.spec.ts", "podcast-search.spec.ts"],
    "assistant": ["agent-platform.spec.ts", "agent-real.spec.ts", "assistant-research.spec.ts"],
    "assistant-settings": ["agent-platform.spec.ts", "assistant-research.spec.ts"],
    "agent-workbench": ["workbenches.spec.ts", "mcp-drafts.spec.ts", "curation.spec.ts"],
    "notifications": ["agent-platform.spec.ts", "workbenches.spec.ts"],
    "playback-sync": ["playback-sync.spec.ts", "podcast-continuation.spec.ts"],
    "system-diagnostics": ["provider-diagnostics.spec.ts", "management.spec.ts"],
    "settings-layout": ["settings-navigation.spec.ts", "personal-settings.spec.ts"],
    "workspace-ui": ["collections.spec.ts", "settings-navigation.spec.ts"],
    "locales": ["i18n.spec.ts"],
}

QUOTED_STR = re.compile(r"""(["'`])([^"'`\n]{0,80})\1""")
CJK_CHAR = re.compile(r"[\u4e00-\u9fff]")
IGNORE_STRINGS = {
    "true",
    "false",
    "null",
    "undefined",
    "string",
    "number",
    "boolean",
    "object",
    "button",
    "input",
    "div",
    "span",
    "section",
    "header",
    "main",
    "nav",
    "utf-8",
    "application/json",
    "zh-CN",
    "en-US",
}


def git_output(args: list[str]) -> str:
    result = subprocess.run(  # nosec B603 B607
        ["git", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout


def changed_files(base: str | None) -> list[str]:
    if base:
        out = git_output(["diff", "--name-only", base])
    else:
        out = git_output(["status", "--porcelain"])
        files = []
        for line in out.splitlines():
            if len(line) > 3:
                path = line[3:].strip()
                if " -> " in path:
                    path = path.split(" -> ", 1)[1]
                files.append(path)
        if not files:
            out = git_output(["diff", "--name-only", "HEAD~1", "HEAD"])
            files = [line.strip() for line in out.splitlines() if line.strip()]
        return sorted(set(files))
    return sorted({line.strip() for line in out.splitlines() if line.strip()})


def current_web_source_corpus() -> str:
    """Concatenate all current Web source & locale files to verify if a removed string is truly gone."""
    parts: list[str] = []
    src_dir = ROOT / "frontend/web/src"
    if src_dir.exists():
        for path in src_dir.rglob("*"):
            if path.is_file() and path.suffix in {".ts", ".tsx", ".json"}:
                parts.append(path.read_text(encoding="utf-8"))
    return "\n".join(parts)


def extract_removed_ui_strings(base: str | None) -> set[str]:
    diff_args = (
        ["diff", "-U0", base, "--", "frontend/web/src/"]
        if base
        else ["diff", "-U0", "HEAD", "--", "frontend/web/src/"]
    )
    diff_text = git_output(diff_args)
    if not diff_text and not base:
        diff_text = git_output(["diff", "-U0", "HEAD~1", "HEAD", "--", "frontend/web/src/"])

    removed: set[str] = set()
    for line in diff_text.splitlines():
        if line.startswith(("---", "+++", "@@")):
            continue
        if line.startswith("-"):
            for _, match in QUOTED_STR.findall(line[1:]):
                candidate = match.strip()
                if candidate in IGNORE_STRINGS:
                    continue
                if (
                    candidate.startswith(("/", "./", "../", "http", "--", "#"))
                    or "{{" in candidate
                    or "${" in candidate
                ):
                    continue
                has_cjk = bool(CJK_CHAR.search(candidate))
                is_english_phrase = " " in candidate and len(candidate) >= 6
                if (has_cjk and len(candidate) >= 3) or is_english_phrase:
                    removed.add(candidate)

    if not removed:
        return set()

    corpus = current_web_source_corpus()
    # A string is truly extinct from the UI only if it no longer appears anywhere in frontend/web/src/
    return {phrase for phrase in removed if phrase not in corpus}


def scan_stale_assertions(removed_strings: set[str]) -> dict[str, list[tuple[int, str]]]:
    """Find Playwright specs that still reference UI strings removed in the current diff."""
    hits: dict[str, list[tuple[int, str]]] = {}
    if not removed_strings or not WEB_TESTS_DIR.exists():
        return hits

    for spec in sorted(WEB_TESTS_DIR.glob("*.spec.ts")):
        lines = spec.read_text(encoding="utf-8").splitlines()
        for idx, line in enumerate(lines, start=1):
            for phrase in sorted(removed_strings):
                if phrase in line:
                    hits.setdefault(spec.name, []).append((idx, phrase))
    return hits


def resolve_affected_tests(
    files: list[str],
    stale_hits: dict[str, list[tuple[int, str]]],
) -> tuple[list[str], list[str]]:
    web_specs: set[str] = set(stale_hits.keys())
    backend_tests: set[str] = set()

    all_backend_tests = (
        {p.name for p in BACKEND_TESTS_DIR.glob("test_*.py")}
        if BACKEND_TESTS_DIR.exists()
        else set()
    )

    for path in files:
        if path.startswith("frontend/web/tests/") and path.endswith(".spec.ts"):
            if (ROOT / path).exists():
                web_specs.add(Path(path).name)
        elif path.startswith("frontend/web/src/"):
            stem = Path(path).stem
            if "locales/" in path:
                web_specs.update(WEB_COMPONENT_TO_SPECS.get("locales", []))
            for key, specs in WEB_COMPONENT_TO_SPECS.items():
                if stem == key or stem.startswith(f"{key}-"):
                    web_specs.update(specs)
            # Also grep for the component stem or imported symbols in specs
            for spec in WEB_TESTS_DIR.glob("*.spec.ts"):
                if stem in spec.stem or stem.replace("-", "_") in spec.stem:
                    web_specs.add(spec.name)
        elif path.startswith("backend/tests/") and path.endswith(".py"):
            if (ROOT / path).exists() and Path(path).name.startswith("test_"):
                backend_tests.add(path)
        elif path.startswith("backend/src/wildstring/") and path.endswith(".py"):
            stem = Path(path).stem
            candidate = f"test_{stem}.py"
            if candidate in all_backend_tests:
                backend_tests.add(f"backend/tests/{candidate}")
            # Search backend tests that import this module
            for test_file in sorted(BACKEND_TESTS_DIR.glob("test_*.py")):
                content = test_file.read_text(encoding="utf-8")
                if f"wildstring.{stem}" in content or f"import {stem}" in content:
                    backend_tests.add(f"backend/tests/{test_file.name}")

    # Filter to existing specs
    valid_web_specs = sorted(s for s in web_specs if (WEB_TESTS_DIR / s).exists())
    return sorted(backend_tests), valid_web_specs


def run_cmd(cmd: list[str], env: dict[str, str] | None = None) -> int:
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    print(f"\n>>> Running: {' '.join(cmd)}", flush=True)
    proc = subprocess.run(cmd, cwd=ROOT, env=merged_env, check=False)  # nosec B603
    return proc.returncode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base", default=None, help="Git ref to diff against (default: working tree or HEAD~1)"
    )
    parser.add_argument(
        "--scan-only",
        action="store_true",
        help="Only scan and report stale test assertions and affected test files without running them",
    )
    parser.add_argument(
        "--fail-on-stale",
        action="store_true",
        help="Exit with non-zero code if any Playwright spec still references an extinct UI string",
    )
    parser.add_argument(
        "--run",
        action="store_true",
        help="Run the affected backend pytest and Web Playwright test suites",
    )
    parser.add_argument(
        "--desktop-only",
        action="store_true",
        help="Run Playwright with --project=desktop for faster local iteration",
    )
    args = parser.parse_args()

    files = changed_files(args.base)
    removed_strings = extract_removed_ui_strings(args.base)
    stale_hits = scan_stale_assertions(removed_strings)
    backend_tests, web_specs = resolve_affected_tests(files, stale_hits)

    print("=== WildString Affected Test & Stale Assertion Report ===")
    print(f"Changed files analyzed: {len(files)}")

    if stale_hits:
        print(
            "\n[!] POTENTIAL STALE TEST ASSERTIONS (tests referencing UI strings removed in diff):"
        )
        for spec_name, occurrences in sorted(stale_hits.items()):
            for line_no, phrase in occurrences:
                print(
                    f"  - frontend/web/tests/{spec_name}:{line_no} -> still contains removed string {phrase!r}"
                )
    else:
        print("\n[OK] No Playwright specs reference removed UI strings from this diff.")

    print(f"\nAffected Backend pytest files ({len(backend_tests)}):")
    for item in backend_tests:
        print(f"  - {item}")

    print(f"\nAffected Web Playwright specs ({len(web_specs)}):")
    for spec in web_specs:
        env_info = SPECIAL_WEB_ENVS.get(spec)
        suffix = f" (env: {env_info})" if env_info else ""
        print(f"  - frontend/web/tests/{spec}{suffix}")

    if args.scan_only or not args.run:
        return 1 if (args.fail_on_stale and stale_hits) else 0

    if backend_tests:
        rc = run_cmd(
            [
                "uv",
                "run",
                "--frozen",
                "--project",
                "backend",
                "--extra",
                "community-sources",
                "pytest",
                "-c",
                "backend/pyproject.toml",
                *backend_tests,
            ]
        )
        if rc != 0:
            return rc

    if web_specs:
        rc = run_cmd(["npm", "--prefix", "frontend/web", "run", "build"])
        if rc != 0:
            return rc

        # Group specs by environment configuration so each group runs in one Playwright invocation
        groups: dict[tuple[tuple[str, str], ...], list[str]] = {}
        for spec in web_specs:
            env_map = SPECIAL_WEB_ENVS.get(spec, {})
            key = tuple(sorted(env_map.items()))
            groups.setdefault(key, []).append(spec)

        for env_tuple, group_specs in groups.items():
            env_dict = dict(env_tuple)
            cmd = ["npm", "--prefix", "frontend/web", "run", "test", "--", *group_specs]
            if args.desktop_only:
                cmd.append("--project=desktop")
            rc = run_cmd(cmd, env=env_dict)
            if rc != 0:
                return rc

    return 0


if __name__ == "__main__":
    sys.exit(main())
