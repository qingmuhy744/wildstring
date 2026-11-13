"""Tests for Homebrew Cask generation script."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import generate_homebrew_cask  # noqa: E402

SAMPLE_SHA = "dfd6f5d64d19aa7585478a1e0a9d543faec9af3cdd5cfcd5ac405bb8ddd7ffce"


def test_parse_dmg_sha256_extracts_macos_dmg() -> None:
    checksums = (
        "0c9df623a306a3707ac8253efacffa13d07abff7764e78d6ccc4cf72becb46f3  wildstring-0.8.10-release.apk\n"
        f"{SAMPLE_SHA.upper()}  WildString-macOS.dmg\n"
    )
    assert generate_homebrew_cask.parse_dmg_sha256(checksums) == SAMPLE_SHA


def test_parse_dmg_sha256_raises_when_missing() -> None:
    with pytest.raises(ValueError, match="WildString-macOS.dmg"):
        generate_homebrew_cask.parse_dmg_sha256("abc  other.zip\n")


def test_render_cask_outputs_valid_cask_definition() -> None:
    cask = generate_homebrew_cask.render_cask(version="v0.8.10", sha256=SAMPLE_SHA)
    assert 'cask "wildstring" do' in cask
    assert 'version "0.8.10"' in cask
    assert f'sha256 "{SAMPLE_SHA}"' in cask
    assert (
        'url "https://github.com/qingmuhy744/wildstring/releases/download/v#{version}/WildString-macOS.dmg"'
        in cask
    )
    assert 'depends_on macos: ">= :sonoma"' in cask
    assert 'app "WildString.app"' in cask
    assert '"-dr", "com.apple.quarantine", "#{appdir}/WildString.app"' in cask
    assert "must_succeed: false" in cask


def test_render_cask_rejects_prerelease_version() -> None:
    with pytest.raises(ValueError, match="stable X.Y.Z"):
        generate_homebrew_cask.render_cask(version="0.8.11-rc.1", sha256=SAMPLE_SHA)


def test_cli_writes_output_file_from_checksums(tmp_path: Path) -> None:
    checksums_file = tmp_path / "SHA256SUMS"
    checksums_file.write_text(f"{SAMPLE_SHA}  WildString-macOS.dmg\n", encoding="utf-8")
    output_file = tmp_path / "Casks" / "wildstring.rb"

    generate_homebrew_cask.main(
        [
            "--version",
            "0.8.10",
            "--checksums-file",
            str(checksums_file),
            "--output",
            str(output_file),
        ]
    )

    content = output_file.read_text(encoding="utf-8")
    assert 'version "0.8.10"' in content
    assert f'sha256 "{SAMPLE_SHA}"' in content
