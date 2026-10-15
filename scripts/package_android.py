"""Package an already-built APK and checksum without including signing keys."""

import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path
from zipfile import ZipFile


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--variant", choices=("debug", "release"), default="debug")
    arguments = parser.parse_args()
    variant = arguments.variant
    root = Path(__file__).resolve().parents[1]
    output = root / f"frontend/android/app/build/outputs/apk/{variant}"
    metadata = json.loads((output / "output-metadata.json").read_text())
    expected_id = "com.wildstring.app" + (".debug" if variant == "debug" else "")
    if metadata["applicationId"] != expected_id or metadata["variantName"] != variant:
        raise ValueError("Unexpected WildString application or build variant")
    elements = metadata["elements"]
    if len(elements) != 1:
        raise ValueError("Expected one universal APK")
    element = elements[0]
    version = element["versionName"]
    filename = element["outputFile"]
    if not re.fullmatch(r"[A-Za-z0-9._-]+", version) or Path(filename).name != filename:
        raise ValueError("Invalid APK metadata")
    source = output / filename
    if not source.is_file() or source.stat().st_size == 0:
        raise ValueError("APK missing or empty")
    with ZipFile(source) as archive:
        names = archive.namelist()
        if "AndroidManifest.xml" not in names or "classes.dex" not in names:
            raise ValueError("Not an Android application package")
        if any(
            Path(name).suffix.lower() in {".mp3", ".flac", ".m4a", ".jks", ".keystore"}
            for name in names
        ):
            raise ValueError("Test audio or signing material must not be packaged in the player")
    destination = root / (
        "artifacts/android" if variant == "debug" else "artifacts/android-release"
    )
    destination.mkdir(parents=True, exist_ok=True)
    apk = destination / f"wildstring-{version}-{variant}.apk"
    shutil.copyfile(source, apk)
    with apk.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    (destination / "SHA256SUMS").write_text(f"{digest}  {apk.name}\n")
    print(f"Packaged {apk.relative_to(root)} ({apk.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
