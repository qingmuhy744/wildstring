"""The CI skip logic must never hide tests: unknown paths and unreadable diffs run everything."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import ci_changed_areas as areas  # noqa: E402


def decide(*files: str) -> tuple[bool, bool]:
    return areas.touches(list(files), areas.BACKEND), areas.touches(list(files), areas.WEB)


@pytest.mark.parametrize(
    "files",
    [
        ("frontend/android/app/src/main/java/com/wildstring/app/ui/PodcastScreen.kt",),
        ("frontend/android/app/src/main/res/values/strings.xml", "CHANGELOG.md"),
        (
            "frontend/ios/WildString/PodcastsView.swift",
            "frontend/macos/WildStringMac/MacPodcasts.swift",
        ),
        ("frontend/apple-shared/ServerRoutesEditor.swift", "README.md", "README.en.md"),
        ("docs/releases/v0.8.16.md", "contracts/podcast-queue.md", "DESIGN.md"),
        (".github/workflows/android.yml",),
    ],
)
def test_native_and_documentation_changes_skip_backend_and_web(files):
    assert decide(*files) == (False, False)


@pytest.mark.parametrize(
    "path",
    ["backend/src/wildstring/main.py", "backend/uv.lock", "backend/tests/test_albums.py"],
)
def test_backend_changes_run_backend_and_web(path):
    # The Web suite runs against the real backend, so backend changes also run Web.
    assert decide(path) == (True, True)


def test_web_changes_run_web_but_not_the_backend_suite():
    assert decide("frontend/web/src/App.tsx") == (False, True)
    assert decide("frontend/web/package-lock.json") == (False, True)


@pytest.mark.parametrize(
    "path", ["scripts/serve_web_tests.py", "Makefile", "plugins/node-runtime/package.json"]
)
def test_shared_inputs_run_everything(path):
    assert decide(path) == (True, True)


def test_the_workflow_itself_runs_everything():
    assert decide(".github/workflows/ci.yml") == (True, True)


@pytest.mark.parametrize(
    "path", ["newdir/thing.py", "setup.cfg", "tools/x.sh", ".github/workflows/release.yml"]
)
def test_unclassified_paths_run_everything(path):
    assert decide(path) == (True, True)


def test_a_mixed_change_runs_what_any_file_needs():
    assert decide("docs/a.md", "backend/src/wildstring/main.py") == (True, True)
    assert decide("frontend/android/a.kt", "frontend/web/src/App.tsx") == (False, True)


def test_no_changes_skip_everything():
    assert decide() == (False, False)


@pytest.mark.parametrize(
    "path",
    [
        "frontend/android/app/build.gradle.kts",
        "Makefile",
        ".github/workflows/codeql.yml",
        ".github/codeql/config.yml",
    ],
)
def test_android_build_inputs_run_the_kotlin_analysis(path):
    assert areas.touches_android([path]) is True


@pytest.mark.parametrize(
    "path",
    [
        "backend/src/wildstring/main.py",
        "frontend/web/src/App.tsx",
        "frontend/ios/x.swift",
        "docs/a.md",
        "CHANGELOG.md",
    ],
)
def test_other_changes_skip_the_kotlin_analysis(path):
    assert areas.touches_android([path]) is False


def test_unclassified_paths_run_the_kotlin_analysis():
    assert areas.touches_android(["newdir/thing.py"]) is True


def test_an_unreadable_diff_runs_everything(monkeypatch, capsys):
    def broken(*args, **kwargs):
        raise subprocess.CalledProcessError(128, "git")

    monkeypatch.setattr(areas.subprocess, "run", broken)
    assert areas.main(["ci_changed_areas.py", "base", "head"]) == 0
    output = capsys.readouterr().out.split()
    assert output == ["backend=true", "web=true", "android=true"]


def test_the_script_reads_a_real_diff(tmp_path):
    def git(*args: str) -> str:
        return subprocess.run(  # noqa: S603
            ["git", "-C", str(tmp_path), *args],  # noqa: S607
            check=True,
            capture_output=True,
            text=True,
        ).stdout

    git("init", "-q", "-b", "main")
    git("config", "user.email", "ci@example.invalid")
    git("config", "user.name", "ci")
    (tmp_path / "frontend/android").mkdir(parents=True)
    (tmp_path / "frontend/android/a.kt").write_text("a\n")
    git("add", "-A")
    git("commit", "-q", "-m", "base")
    git("checkout", "-q", "-b", "topic")
    (tmp_path / "frontend/android/a.kt").write_text("b\n")
    git("commit", "-q", "-am", "android only")
    script = ROOT / "scripts/ci_changed_areas.py"
    out = subprocess.run(  # noqa: S603
        [sys.executable, str(script), "main", "topic"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.split()
    assert out == ["backend=false", "web=false", "android=true"]
    (tmp_path / "backend").mkdir()
    (tmp_path / "backend/x.py").write_text("x\n")
    git("add", "-A")
    git("commit", "-q", "-m", "backend")
    out = subprocess.run(  # noqa: S603
        [sys.executable, str(script), "main", "topic"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.split()
    assert out == ["backend=true", "web=true", "android=true"]
