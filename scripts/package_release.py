"""Package actual Web build outputs for a matching versioned release."""

import argparse
import hashlib
import json
import re
import tomllib
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", required=True)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "artifacts")
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
