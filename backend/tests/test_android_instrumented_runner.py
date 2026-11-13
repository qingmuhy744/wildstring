"""Tests for the Android instrumented-suite shard split."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import run_android_instrumented  # noqa: E402

CLASSES = {f"com.wildstring.app.Class{index:02d}Test": ["test"] for index in range(7)}


def test_shards_cover_every_class_exactly_once() -> None:
    seen: list[str] = []
    for index in range(3):
        seen.extend(run_android_instrumented.shard(CLASSES, index, 3))
    assert sorted(seen) == sorted(CLASSES)
    assert len(seen) == len(set(seen))


def test_shards_stay_balanced() -> None:
    sizes = [len(run_android_instrumented.shard(CLASSES, index, 2)) for index in range(2)]
    assert max(sizes) - min(sizes) <= 1


def test_single_shard_keeps_the_whole_selection() -> None:
    assert run_android_instrumented.shard(CLASSES, 0, 1) == CLASSES


def test_invalid_shard_arguments_are_rejected() -> None:
    with pytest.raises(SystemExit, match="shard-index"):
        run_android_instrumented.shard(CLASSES, 2, 2)
    with pytest.raises(SystemExit, match="shard-count"):
        run_android_instrumented.shard(CLASSES, 0, 0)
