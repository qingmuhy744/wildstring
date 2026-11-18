"""Tests for scripts/release_verify_scope.py release-gate deduplication."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import release_verify_scope as scope  # noqa: E402


def _mock_git(monkeypatch, *, tags: str, changed: str, gradle_diff: str = "") -> None:
    def fake_run_git(*args: str) -> str:
        if args[:2] == ("tag", "--merged"):
            return tags
        if args[:2] == ("diff", "--name-only"):
            return changed
        if args[:2] == ("diff", "-U0"):
            return gradle_diff
        raise AssertionError(f"Unexpected git command: {args}")

    monkeypatch.setattr(scope, "run_git", fake_run_git)


def test_version_bump_and_web_changes_skip_android_emulator(monkeypatch) -> None:
    _mock_git(
        monkeypatch,
        tags="v0.8.20-rc.1\nv0.8.19\n",
        changed="frontend/web/src/App.tsx\nfrontend/android/app/build.gradle.kts\ndocs/releases/v0.8.20.md\n",
        gradle_diff=(
            "diff --git a/frontend/android/app/build.gradle.kts b/frontend/android/app/build.gradle.kts\n"
            "@@ -20,2 +20,2 @@\n"
            "-        versionCode = 55\n"
            '-        versionName = "0.8.19"\n'
            "+        versionCode = 56\n"
            '+        versionName = "0.8.20"\n'
        ),
    )
    run, reason = scope.needs_android_emulator("v0.8.20")
    assert run is False
    assert "v0.8.19" in reason


def test_real_build_gradle_change_runs_android_emulator(monkeypatch) -> None:
    _mock_git(
        monkeypatch,
        tags="v0.8.19\n",
        changed="frontend/android/app/build.gradle.kts\n",
        gradle_diff=(
            "@@ -20,2 +20,2 @@\n"
            "-        versionCode = 55\n"
            "+        versionCode = 56\n"
            "+        isMinifyEnabled = false\n"
        ),
    )
    run, _ = scope.needs_android_emulator("v0.8.20")
    assert run is True


def test_kotlin_or_fixture_change_runs_android_emulator(monkeypatch) -> None:
    _mock_git(
        monkeypatch,
        tags="v0.8.19\n",
        changed="frontend/android/app/src/main/java/com/wildstring/app/MainActivity.kt\n",
    )
    run, _ = scope.needs_android_emulator("v0.8.20")
    assert run is True

    _mock_git(
        monkeypatch,
        tags="v0.8.19\n",
        changed="tests/fixtures/audio/sample.mp3\n",
    )
    run_fixture, _ = scope.needs_android_emulator("v0.8.20")
    assert run_fixture is True


def test_missing_previous_tag_or_git_failure_falls_back_to_running_emulator(monkeypatch) -> None:
    _mock_git(monkeypatch, tags="", changed="")
    run, _ = scope.needs_android_emulator("v0.8.20")
    assert run is True

    def broken_git(*args: str) -> str:
        raise subprocess.CalledProcessError(128, "git")

    monkeypatch.setattr(scope, "run_git", broken_git)
    run_broken, _ = scope.needs_android_emulator("v0.8.20")
    assert run_broken is True


def test_prerelease_considers_prior_prerelease_tag(monkeypatch) -> None:
    _mock_git(
        monkeypatch,
        tags="v0.8.20-rc.1\nv0.8.19\n",
        changed="backend/src/wildstring/main.py\n",
    )
    run, reason = scope.needs_android_emulator("v0.8.20-rc.2")
    assert run is False
    assert "v0.8.20-rc.1" in reason


def test_ci_verify_skips_only_on_passing_trusted_run(monkeypatch) -> None:
    sha = "a" * 40
    monkeypatch.setattr(
        scope,
        "fetch_workflow_runs",
        lambda repo, head, token: [
            {
                "id": 1001,
                "path": ".github/workflows/ci.yml",
                "head_sha": sha,
                "conclusion": "success",
                "event": "push",
            }
        ],
    )
    run, _ = scope.needs_ci_verify("owner/repo", sha, "tok")
    assert run is False

    # A pull_request CI run alone does not skip main release verification.
    monkeypatch.setattr(
        scope,
        "fetch_workflow_runs",
        lambda repo, head, token: [
            {
                "id": 1002,
                "path": ".github/workflows/ci.yml",
                "head_sha": sha,
                "conclusion": "success",
                "event": "pull_request",
            }
        ],
    )
    run_pr, _ = scope.needs_ci_verify("owner/repo", sha, "tok")
    assert run_pr is True


def test_ci_verify_falls_back_on_failed_run_or_api_error(monkeypatch) -> None:
    sha = "b" * 40
    monkeypatch.setattr(
        scope,
        "fetch_workflow_runs",
        lambda repo, head, token: [
            {
                "id": 1003,
                "path": ".github/workflows/ci.yml",
                "head_sha": sha,
                "conclusion": "failure",
                "event": "push",
            }
        ],
    )
    assert scope.needs_ci_verify("owner/repo", sha, "tok")[0] is True

    def raise_error(repo: str, head: str, token: str):
        raise OSError("network timeout")

    monkeypatch.setattr(scope, "fetch_workflow_runs", raise_error)
    assert scope.needs_ci_verify("owner/repo", sha, "tok")[0] is True
    assert scope.needs_ci_verify("", sha, "tok")[0] is True
