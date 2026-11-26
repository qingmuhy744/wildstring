#!/usr/bin/env python3
"""Run one balanced slice of the Makefile Web E2E suites for CI matrix jobs."""

from __future__ import annotations

import argparse
import os
import subprocess  # nosec B404 - invokes fixed make targets without shell
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Each entry is (make_target, unique_output_slug, playwright_shard_or_None).
# Partition weights reflect observed CI durations (~3-3.5m per shard vs ~17m serial).
SHARDS: dict[int, tuple[tuple[str, str, str | None], ...]] = {
    0: (
        ("test-web", "web-1", "1/3"),
        ("test-publisher-web", "publisher", None),
        ("test-catalog-web", "catalog", None),
    ),
    1: (
        ("test-web", "web-2", "2/3"),
        ("test-large-web", "large", None),
        ("test-transcoding-web", "transcoding", None),
    ),
    2: (
        ("test-web", "web-3", "3/3"),
        ("test-browse-web", "browse", None),
    ),
    3: (
        ("test-podcast-web", "podcast-1", "1/2"),
        ("test-libraries-web", "libraries", None),
    ),
    4: (("test-podcast-web", "podcast-2", "2/2"), ("test-web", "gdrive", None)),
}
SHARD_COUNT = len(SHARDS)


def build_web_test_args(slug: str, shard: str | None) -> str:
    """Format Playwright CLI flags passed via WEB_TEST_ARGS."""
    flags = [f"--output=../../artifacts/browser-tests/{slug}"]
    if shard:
        flags.append(f"--shard={shard}")
    return " ".join(flags)


def run_shard(shard_index: int) -> None:
    """Build Web once, then execute every Playwright slice assigned to shard_index."""
    if shard_index not in SHARDS:
        raise SystemExit(f"--shard must be between 0 and {SHARD_COUNT - 1} (got {shard_index})")

    print("[web-shard] Building frontend/web once for this shard", flush=True)
    subprocess.run(["make", "build-web"], cwd=ROOT, check=True)  # nosec B603 B607

    for target, slug, part in SHARDS[shard_index]:
        web_args = build_web_test_args(slug, part)
        env = os.environ.copy()
        if slug == "gdrive":
            web_args += " gdrive-storage.spec.ts"
            env["WILDSTRING_TEST_GDRIVE"] = "1"
        print(f"[web-shard {shard_index}] Running {target} ({web_args})", flush=True)
        subprocess.run(  # nosec B603 B607 - fixed make command, no shell
            ["make", target, "SKIP_WEB_BUILD=1", f"WEB_TEST_ARGS={web_args}"],
            cwd=ROOT,
            env=env,
            check=True,
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--shard",
        type=int,
        required=True,
        help=f"Zero-based shard index (0..{SHARD_COUNT - 1})",
    )
    options = parser.parse_args(argv)
    run_shard(options.shard)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
