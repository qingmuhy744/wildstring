"""Package actual Web build outputs for a matching versioned release."""

import argparse
import hashlib
import json
import re
import subprocess
import tomllib
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from release_verify_scope import run_git

ROOT = Path(__file__).resolve().parents[1]
ANDROID_CONFIG = "frontend/android/app/build.gradle.kts"
APPLE_CONFIGS = {"macOS": "frontend/macos/project.yml", "iOS": "frontend/ios/project.yml"}


def build_number(config: str, setting: str) -> int:
    number = re.search(rf'^\s*{setting}[ =:]+"?(\d+)"?\s*$', config, re.MULTILINE)
    if number is None or int(number[1]) < 1:
        raise ValueError(f"{setting} must be a positive integer")
    return int(number[1])


def check_native_builds(android_config: str, apple_version: str, previous_tag: str | None) -> None:
    build_configs = [(ANDROID_CONFIG, "versionCode", build_number(android_config, "versionCode"))]
    for platform, path in APPLE_CONFIGS.items():
        config = (ROOT / path).read_text()
        marketing = re.search(r'^\s*MARKETING_VERSION:\s*"?([\d.]+)"?\s*$', config, re.MULTILINE)
        if marketing is None or marketing[1] != apple_version:
            raise ValueError(f"{platform} MARKETING_VERSION must match {apple_version}")
        build_configs.append(
            (path, "CURRENT_PROJECT_VERSION", build_number(config, "CURRENT_PROJECT_VERSION"))
        )
    if not previous_tag:
        return
    for path, setting, current in build_configs:
        previous = build_number(run_git("show", f"refs/tags/{previous_tag}:{path}"), setting)
        if current <= previous:
            raise ValueError(
                f"{path} {setting} must increase from {previous_tag} ({previous} → {current})"
            )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", required=True)
    parser.add_argument("--previous-tag", help="Compare build numbers with this published tag")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "artifacts")
    parser.add_argument("--check-only", action="store_true")
    arguments = parser.parse_args()
    match = re.fullmatch(r"v(\d+\.\d+\.\d+)(?:-(dev|alpha|beta|rc)\.(\d+))?", arguments.tag)
    if match is None:
        parser.error("Use vX.Y.Z or vX.Y.Z-(dev|alpha|beta|rc).N")
    base, channel, number = match.groups()
    suffixes = {"dev": ".dev", "alpha": "a", "beta": "b", "rc": "rc"}
    expected_python = base + (f"{suffixes[channel]}{number}" if channel else "")
    expected_web = arguments.tag.removeprefix("v")
    with (ROOT / "backend/pyproject.toml").open("rb") as source:
        python_version = tomllib.load(source)["project"]["version"]
    web_version = json.loads((ROOT / "frontend/web/package.json").read_text())["version"]
    if python_version != expected_python or web_version != expected_web:
        parser.error("Release tag must match backend and Web package versions; update both first")
    android_config = (ROOT / ANDROID_CONFIG).read_text()
    android_version = re.search(r'versionName = "([^"]+)"', android_config)
    if android_version is None or android_version[1] != expected_web:
        parser.error("Release tag must also match the Android versionName")
    try:
        check_native_builds(android_config, base, arguments.previous_tag)
    except (ValueError, subprocess.CalledProcessError) as error:
        parser.error(str(error))
    if arguments.check_only:
        print(f"Backend, Web, Android, macOS and iOS versions match {arguments.tag}")
        return
    dist = ROOT / "frontend/web/dist"
    if not (dist / "index.html").is_file():
        parser.error("Web build is missing; run make build-web")
    arguments.output_dir.mkdir(parents=True, exist_ok=True)
    archive = arguments.output_dir / f"wildstring-web-{arguments.tag}.zip"
    with ZipFile(archive, "w", compression=ZIP_DEFLATED) as output:
        for path in sorted(dist.rglob("*")):
            if path.is_file():
                output.write(path, Path("web") / path.relative_to(dist))
        output.write(ROOT / "LICENSE", "LICENSE")
        output.writestr(
            "README.txt",
            f"WildString {arguments.tag}\n"
            "Set WILDSTRING_WEB_DIR to the extracted web directory when running the backend.\n"
            "The GHCR image already includes this Web build.\n",
        )
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (arguments.output_dir / "SHA256SUMS").write_text(f"{digest}  {archive.name}\n")
    print(f"Packaged {archive.name}")


if __name__ == "__main__":
    main()
