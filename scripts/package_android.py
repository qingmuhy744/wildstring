"""Package an already-built debug APK and checksum without including signing keys."""

import hashlib
import json
import re
import shutil
from pathlib import Path
from zipfile import ZipFile


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    output = root / "frontend/android/app/build/outputs/apk/debug"
    metadata = json.loads((output / "output-metadata.json").read_text())
    if metadata["applicationId"] != "dev.wildstring.app.debug":
        raise ValueError("Expected the WildString debug application")
    elements = metadata["elements"]
    if len(elements) != 1:
        raise ValueError("Expected one universal debug APK")
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
    destination = root / "artifacts/android"
    destination.mkdir(parents=True, exist_ok=True)
    apk = destination / f"wildstring-{version}-debug.apk"
    shutil.copyfile(source, apk)
    with apk.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    (destination / "SHA256SUMS").write_text(f"{digest}  {apk.name}\n")
    print(f"Packaged {apk.relative_to(root)} ({apk.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
