#!/usr/bin/env python3
"""Determine Release workflow verification scope from Git history and GitHub Actions."""

from __future__ import annotations

import json
import os
import re
import subprocess  # nosec B404 - invokes fixed git commands without shell
import sys
import urllib.error
import urllib.parse
import urllib.request

ANDROID_EMULATOR_INPUTS = (
    "frontend/android/",
    "tests/fixtures/audio/",
    "scripts/run_android_instrumented.py",
    "scripts/ci_synthetic_api.sh",
    "scripts/serve_web_tests.py",
    ".github/workflows/android.yml",
)
VERSION_BUMP_LINE = re.compile(r"^\s*version(?:Code|Name)\s*=\s*")
REPO_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
SHA_PATTERN = re.compile(r"^[0-9a-fA-F]{40}$")
CI_WORKFLOW_PATH = ".github/workflows/ci.yml"
TRUSTED_CI_EVENTS = frozenset({"push", "workflow_dispatch", "workflow_call"})


def run_git(*args: str) -> str:
    completed = subprocess.run(  # nosec B603 B607 - fixed git binary, no shell
        ["git", *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout


def find_previous_tag(release_tag: str, ref: str = "HEAD~1") -> str | None:
    try:
        output = run_git("tag", "--merged", ref, "--list", "v[0-9]*", "--sort=-v:refname")
    except subprocess.CalledProcessError:
        return None
    is_prerelease = "-" in release_tag
    for line in output.splitlines():
        tag = line.strip()
        if not tag or tag == release_tag:
            continue
        if not is_prerelease and "-" in tag:
            continue
        return tag
    return None


def is_pure_android_version_bump(prev_tag: str, head: str = "HEAD") -> bool:
    try:
        diff = run_git(
            "diff",
            "-U0",
            f"{prev_tag}...{head}",
            "--",
            "frontend/android/app/build.gradle.kts",
        )
    except subprocess.CalledProcessError:
        return False
    changed_lines = [
        line[1:]
        for line in diff.splitlines()
        if (line.startswith("+") and not line.startswith("+++"))
        or (line.startswith("-") and not line.startswith("---"))
    ]
    return bool(changed_lines) and all(VERSION_BUMP_LINE.match(line) for line in changed_lines)


def needs_android_emulator(release_tag: str, head: str = "HEAD") -> tuple[bool, str]:
    prev_tag = find_previous_tag(release_tag)
    if not prev_tag:
        return True, "no previous release tag found; running full Android emulator suite"
    try:
        changed = [
            line.strip()
            for line in run_git("diff", "--name-only", f"{prev_tag}...{head}").splitlines()
            if line.strip()
        ]
    except subprocess.CalledProcessError as error:
        return True, f"git diff against {prev_tag} failed ({error.returncode}); running emulator"

    for path in changed:
        if path == "frontend/android/app/build.gradle.kts":
            if not is_pure_android_version_bump(prev_tag, head):
                return (
                    True,
                    f"non-version change in {path} since {prev_tag}; running Android emulator",
                )
            continue
        if path.startswith(ANDROID_EMULATOR_INPUTS):
            return True, f"Android input {path} changed since {prev_tag}; running Android emulator"
    return False, f"no functional Android inputs changed since {prev_tag}; skipping emulator"


def fetch_workflow_runs(repo: str, head_sha: str, token: str) -> list[dict[str, object]]:
    if not REPO_PATTERN.fullmatch(repo) or not SHA_PATTERN.fullmatch(head_sha):
        raise ValueError("Invalid repository or commit SHA format")
    url = f"https://api.github.com/repos/{repo}/actions/runs?head_sha={head_sha}&status=completed&per_page=100"
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.netloc != "api.github.com":
        raise ValueError("Unexpected GitHub API URL")
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "wildstring-release-scope",
        },
    )
    with urllib.request.urlopen(request, timeout=15) as response:  # nosec B310 - fixed https://api.github.com
        payload = json.loads(response.read().decode("utf-8"))
    runs = payload.get("workflow_runs")
    return runs if isinstance(runs, list) else []


def needs_ci_verify(repo: str, head_sha: str, token: str) -> tuple[bool, str]:
    if not repo or not head_sha or not token:
        return True, "missing GitHub API environment; running CI verify"
    try:
        runs = fetch_workflow_runs(repo, head_sha, token)
    except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError) as error:
        return True, f"GitHub API query failed ({error}); running CI verify"

    for run in runs:
        if (
            isinstance(run, dict)
            and run.get("path") == CI_WORKFLOW_PATH
            and run.get("head_sha") == head_sha
            and run.get("conclusion") == "success"
            and run.get("event") in TRUSTED_CI_EVENTS
        ):
            return (
                False,
                f"CI run {run.get('id')} already passed on {head_sha[:8]}; skipping verify",
            )
    return True, f"no passing main CI run found on {head_sha[:8]}; running CI verify"


def main() -> int:
    release_tag = os.environ.get("RELEASE_TAG", "")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    head_sha = os.environ.get("GITHUB_SHA", "")
    token = os.environ.get("GH_TOKEN", "")

    run_emulator, emulator_reason = needs_android_emulator(release_tag)
    run_ci, ci_reason = needs_ci_verify(repo, head_sha, token)

    print(f"[release-scope] {emulator_reason}", file=sys.stderr)
    print(f"[release-scope] {ci_reason}", file=sys.stderr)
    print(f"run_android_emulator={'true' if run_emulator else 'false'}")
    print(f"run_ci_verify={'true' if run_ci else 'false'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
