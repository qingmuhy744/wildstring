"""Tests verifying the CI Web E2E shard partition matches Makefile and ci.yml."""

from __future__ import annotations

import re
import sys
from collections import defaultdict
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import run_web_ci_shard  # noqa: E402

EXPECTED_TARGETS = {
    "test-web",
    "test-podcast-web",
    "test-publisher-web",
    "test-libraries-web",
    "test-large-web",
    "test-browse-web",
    "test-catalog-web",
    "test-transcoding-web",
}


def test_shards_cover_every_web_target_completely() -> None:
    parts: dict[str, list[str | None]] = defaultdict(list)
    slugs: list[str] = []
    for entries in run_web_ci_shard.SHARDS.values():
        for target, slug, part in entries:
            parts[target].append(part)
            slugs.append(slug)

    assert set(parts) == EXPECTED_TARGETS
    assert len(slugs) == len(set(slugs))
    for target, shards in parts.items():
        if shards == [None]:
            continue
        parsed = sorted(tuple(int(n) for n in item.split("/")) for item in shards if item)
        assert len(parsed) == len(shards), f"{target} mixes sharded and unsharded entries"
        total = parsed[0][1]
        assert total > 1
        assert parsed == [(idx, total) for idx in range(1, total + 1)], (
            f"{target} has incomplete shards: {shards}"
        )


@pytest.mark.skipif(
    not (ROOT / ".github/workflows/ci.yml").is_file(),
    reason="the container test image omits .github; the host run covers this",
)
def test_ci_workflow_matrix_matches_shard_count() -> None:
    ci_text = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
    match = re.search(r"web_shard:[\s\S]*?matrix:\s*\n\s*shard:\s*\[([^\]]+)\]", ci_text)
    assert match is not None
    indices = [int(item.strip()) for item in match.group(1).split(",")]
    assert indices == sorted(run_web_ci_shard.SHARDS)


def test_spec_slices_are_valid_and_unique() -> None:
    shard_slugs = {slug for entries in run_web_ci_shard.SHARDS.values() for _, slug, _ in entries}
    seen_spec_slugs: set[str] = set()
    for shard_index, slices in run_web_ci_shard.SPEC_SLICES.items():
        assert shard_index in run_web_ci_shard.SHARDS
        for target, slug, spec, extra_env in slices:
            assert target in EXPECTED_TARGETS
            assert slug not in shard_slugs and slug not in seen_spec_slugs
            seen_spec_slugs.add(slug)
            assert spec.endswith(".spec.ts")
            assert isinstance(extra_env, dict) and extra_env


def test_invalid_shard_is_rejected() -> None:
    with pytest.raises(SystemExit, match="shard must be between"):
        run_web_ci_shard.run_shard(run_web_ci_shard.SHARD_COUNT)
