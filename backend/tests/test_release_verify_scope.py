"""Tests for scripts/release_verify_scope.py release-gate deduplication."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import package_release  # noqa: E402
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

    _mock_git(
        monkeypatch,
        tags="v0.8.19\n",
        changed="scripts/ci_recover_emulator.sh\n",
    )
    run_recovery, _ = scope.needs_android_emulator("v0.8.20")
    assert run_recovery is True


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
    assert run is True
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


def test_find_previous_tag_skips_unpublished_tags(monkeypatch):
    def fake_run_git(*args: str) -> str:
        assert args[:2] == ("tag", "--merged")
        return "v0.8.21\nv0.8.20\n"

    monkeypatch.setattr(scope, "run_git", fake_run_git)
    assert scope.find_previous_tag("v0.8.22", published_tags={"v0.8.20"}) == "v0.8.20"
    assert scope.find_previous_tag("v0.8.22", published_tags=set()) is None


def test_needs_android_emulator_uses_published_baseline(monkeypatch):
    seen_diffs: list[tuple[str, ...]] = []

    def fake_run_git(*args: str) -> str:
        if args[0] == "tag":
            return "v0.8.21\nv0.8.20\n"
        if args[0] == "diff":
            seen_diffs.append(args)
            return "frontend/android/app/src/main/java/App.kt\n"
        raise AssertionError(f"unexpected git args: {args}")

    monkeypatch.setattr(scope, "run_git", fake_run_git)
    run_emu, reason = scope.needs_android_emulator("v0.8.22", published_tags={"v0.8.20"})
    assert run_emu is True
    assert "v0.8.20" in reason
    assert seen_diffs == [("diff", "--name-only", "--no-renames", "v0.8.20...HEAD")]

    run_empty, empty_reason = scope.needs_android_emulator("v0.8.22", published_tags=set())
    assert run_empty is True
    assert "no previous published release tag found" in empty_reason


def test_fetch_published_release_tags_ignores_drafts(monkeypatch):
    import io
    import json

    captured: dict[str, object] = {}

    class FakeResponse(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            self.close()
            return False

    def fake_urlopen(request, timeout: int = 0):
        captured["url"] = request.full_url
        captured["auth"] = request.headers.get("Authorization")
        captured["timeout"] = timeout
        payload = [
            {"tag_name": "v0.8.21", "draft": True},
            {"tag_name": "v0.8.20", "draft": False},
            {"tag_name": "", "draft": False},
            {"tag_name": "v0.8.19"},
        ]
        return FakeResponse(json.dumps(payload).encode("utf-8"))

    monkeypatch.setattr(scope.urllib.request, "urlopen", fake_urlopen)
    tags = scope.fetch_published_release_tags("owner/repo", "secret-token")
    assert tags == {"v0.8.20", "v0.8.19"}
    assert captured["url"] == "https://api.github.com/repos/owner/repo/releases?per_page=100"
    assert captured["auth"] == "Bearer secret-token"
    assert captured["timeout"] == 15

    assert scope.resolve_published_tags("", "tok")[0] is None
    assert scope.resolve_published_tags("owner/repo", "")[0] is None


def test_main_fails_closed_when_published_lookup_fails(monkeypatch, capsys):
    monkeypatch.setenv("RELEASE_TAG", "v0.8.22")
    monkeypatch.setenv("GITHUB_REPOSITORY", "owner/repo")
    monkeypatch.setenv("GITHUB_SHA", "a" * 40)
    monkeypatch.setenv("GH_TOKEN", "tok")

    monkeypatch.setattr(scope, "resolve_published_tags", lambda _r, _t: (None, "lookup failed"))
    monkeypatch.setattr(scope, "needs_ci_verify", lambda _r, _h, _t: (False, "reused CI"))

    def fail_if_called(*args, **kwargs):
        raise AssertionError("needs_android_emulator should not run when published lookup failed")

    monkeypatch.setattr(scope, "needs_android_emulator", fail_if_called)
    assert scope.main() == 0
    out = capsys.readouterr().out
    assert "run_android_emulator=true" in out
    assert "run_ci_verify=false" in out


def test_main_forwards_published_tags(monkeypatch, capsys):
    monkeypatch.setenv("RELEASE_TAG", "v0.8.22")
    monkeypatch.setenv("GITHUB_REPOSITORY", "owner/repo")
    monkeypatch.setenv("GITHUB_SHA", "a" * 40)
    monkeypatch.setenv("GH_TOKEN", "tok")

    monkeypatch.setattr(scope, "resolve_published_tags", lambda _r, _t: ({"v0.8.20"}, ""))
    monkeypatch.setattr(scope, "needs_ci_verify", lambda _r, _h, _t: (False, "reused CI"))

    seen: dict[str, object] = {}

    def fake_needs(release_tag: str, head: str = "HEAD", published_tags=None):
        seen["release_tag"] = release_tag
        seen["published_tags"] = published_tags
        return False, "no android changes since v0.8.20"

    monkeypatch.setattr(scope, "needs_android_emulator", fake_needs)
    assert scope.main() == 0
    out = capsys.readouterr().out
    assert "run_android_emulator=false" in out
    assert seen == {"release_tag": "v0.8.22", "published_tags": {"v0.8.20"}}


def test_release_device_scope_distinguishes_dependency_changes_from_version_bumps(monkeypatch):
    inputs = {
        "v0.8.24": '[project]\nversion = "0.8.24"\ndependencies = ["fastapi"]',
        "HEAD": '[project]\nversion = "0.8.25"\ndependencies = ["fastapi"]',
    }

    def fake_run_git(command, *args):
        if command == "tag":
            return "v0.8.24\n"
        if command == "diff":
            return "backend/pyproject.toml\n"
        ref, _ = args[0].split(":")
        return inputs[ref]

    monkeypatch.setattr(scope, "run_git", fake_run_git)
    assert not scope.needs_android_emulator("v0.8.25")[0]
    inputs["HEAD"] = inputs["HEAD"].replace('"fastapi"', '"fastapi>=1"')
    assert scope.needs_android_emulator("v0.8.25")[0]


def test_latest_stable_prefers_numeric_version_even_when_an_older_release_was_republished():
    assert scope.latest_stable(["v0.8.9", "v0.8.10", "v0.9.0-rc.1", "v0.8.2"]) == "v0.8.10"
    assert scope.latest_stable(["v0.9.0-rc.1"]) is None


def test_release_rejects_nonincreasing_build_numbers_and_mismatched_apple_version(
    monkeypatch, tmp_path
):
    monkeypatch.setattr(package_release, "ROOT", tmp_path)
    for relative in package_release.APPLE_CONFIGS.values():
        config = tmp_path / relative
        config.parent.mkdir(parents=True)
        config.write_text('MARKETING_VERSION: "0.8.25"\nCURRENT_PROJECT_VERSION: "60"\n')

    def older_build(_command, path):
        return 'CURRENT_PROJECT_VERSION: "59"' if path.endswith(".yml") else "versionCode = 60"

    monkeypatch.setattr(package_release, "run_git", older_build)
    package_release.check_native_builds("versionCode = 61", "0.8.25", "v0.8.24")
    with pytest.raises(ValueError, match="versionCode must increase"):
        package_release.check_native_builds("versionCode = 60", "0.8.25", "v0.8.24")
    with pytest.raises(ValueError, match="MARKETING_VERSION must match"):
        package_release.check_native_builds("versionCode = 61", "0.8.26", "v0.8.24")
