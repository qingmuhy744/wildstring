#!/usr/bin/env python3
"""Run the repository's CodeQL configuration with the installed CLI."""

import argparse
import json
import shutil
import subprocess  # nosec B404
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ".github/codeql/config.yml"
BUILD_MODES = {
    "python": "none",
    "javascript-typescript": "none",
    "actions": "none",
    "java-kotlin": "manual",
}
DEFAULT_LANGUAGES = tuple(name for name, mode in BUILD_MODES.items() if mode == "none")


def summarize(sarif: Path, language: str) -> int:
    count = 0
    for run in json.loads(sarif.read_text(encoding="utf-8"))["runs"]:
        for result in run.get("results", []):
            location = next(iter(result.get("locations", [])), {}).get("physicalLocation", {})
            path = unquote(location.get("artifactLocation", {}).get("uri", "(unknown file)"))
            line = location.get("region", {}).get("startLine", "?")
            message = result["message"].get("text") or result["message"]["markdown"]
            print(f"{language}: {path}:{line} [{result['ruleId']}] {' '.join(message.split())}")
            count += 1
    return count


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--languages", metavar="LIST", help="comma-separated CI language names")
    selection.add_argument("--all", action="store_true", help="include the Android build")
    args = parser.parse_args(argv)
    languages = tuple(BUILD_MODES) if args.all else DEFAULT_LANGUAGES
    if args.languages is not None:
        languages = tuple(dict.fromkeys(name.strip() for name in args.languages.split(",")))
        unknown = set(languages) - BUILD_MODES.keys()
        if unknown:
            parser.error(f"unknown language(s) {', '.join(sorted(unknown))!r}")
    cli = shutil.which("codeql")
    if cli is None:
        print(
            "CodeQL CLI not found. Install the official CodeQL CLI bundle and add codeql to PATH.",
            file=sys.stderr,
        )
        return 2

    cache = ROOT / ".cache" / "codeql"
    cache.mkdir(parents=True, exist_ok=True)
    output = Path(tempfile.mkdtemp(prefix="run-", dir=cache))
    print(f"CodeQL output: {output}", flush=True)
    findings = 0
    try:
        for language in languages:
            database = output / language
            sarif = output / f"{language}.sarif"
            mode = BUILD_MODES[language]
            create = [
                cli,
                "database",
                "create",
                str(database),
                f"--language={language}",
                f"--build-mode={mode}",
                f"--codescanning-config={CONFIG}",
                "--threads=4",
            ]
            if mode == "manual":
                create.append("--command=bash scripts/retry_on_429.sh make android-codeql")
            subprocess.run(create, cwd=ROOT, check=True)  # nosec B603
            subprocess.run(  # nosec B603
                [
                    cli,
                    "database",
                    "analyze",
                    str(database),
                    "--format=sarif-latest",
                    f"--output={sarif}",
                    "--threads=4",
                ],
                cwd=ROOT,
                check=True,
            )
            count = summarize(sarif, language)
            print(f"{language}: {count} finding(s)", flush=True)
            findings += count
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"CodeQL scan failed: {error}", file=sys.stderr)
        return 2
    return int(findings > 0)


if __name__ == "__main__":
    raise SystemExit(main())
