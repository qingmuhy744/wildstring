"""Regression checks for independent imports and failed no-follow directory walks."""

import os
import subprocess
import sys
from pathlib import Path

import pytest

from wildstring.library.import_files import target_directory
from wildstring.library.scanner import open_source


@pytest.mark.parametrize(
    "module",
    [
        "wildstring.agent_ai",
        "wildstring.agent_automation",
        "wildstring.agent_notifications",
        "wildstring.agent_research",
        "wildstring.library.intake",
        "wildstring.lyric_scans",
    ],
)
def test_services_can_be_imported_first_in_a_fresh_interpreter(module):
    subprocess.run(
        [
            sys.executable,
            "-c",
            "import importlib, sys; importlib.import_module(sys.argv[1])",
            module,
        ],
        check=True,
        capture_output=True,
    )


@pytest.mark.skipif(os.open not in os.supports_dir_fd, reason="POSIX directory descriptors")
@pytest.mark.parametrize("opener", [open_source, target_directory])
def test_failed_directory_walk_closes_all_parents(tmp_path, monkeypatch, opener):
    root = tmp_path / "root"
    (root / "parent").mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "parent/link").symlink_to(outside, target_is_directory=True)
    opened, closed = [], []
    real_open, real_close = os.open, os.close

    def tracked_open(*args, **kwargs):
        descriptor = real_open(*args, **kwargs)
        opened.append(descriptor)
        return descriptor

    def tracked_close(descriptor):
        closed.append(descriptor)
        real_close(descriptor)

    monkeypatch.setattr(os, "supports_dir_fd", os.supports_dir_fd | {tracked_open})
    monkeypatch.setattr(os, "open", tracked_open)
    monkeypatch.setattr(os, "close", tracked_close)
    with pytest.raises(OSError):
        with opener(root, Path("parent/link/song.flac")):
            pytest.fail("A symlink parent must never be opened")
    assert opened
    assert closed == list(reversed(opened))
    assert list(outside.iterdir()) == []
