"""Exercise the built container rather than its deployment configuration."""

import errno
import json
import os
import subprocess
from tempfile import TemporaryFile
from urllib.error import HTTPError
from urllib.request import urlopen

from wildstring.config import Settings


def main() -> None:
    if os.getuid() == 0:
        raise SystemExit("Container must run as a non-root user")
    with urlopen("http://127.0.0.1:8000/health/ready", timeout=5) as response:  # nosec B310
        if json.load(response).get("status") != "ok":
            raise SystemExit("Container is not ready")
    with urlopen("http://127.0.0.1:8000/", timeout=5) as response:  # nosec B310
        if b"<html" not in response.read():
            raise SystemExit("Packaged Web UI is missing")
    try:
        with urlopen("http://127.0.0.1:8000/api/v1/tracks?limit=1", timeout=5):  # nosec B310
            raise SystemExit("Library API must require authentication")
    except HTTPError as error:
        if error.code != 401:
            raise SystemExit("Library API did not return an authentication challenge") from error
    with urlopen("http://127.0.0.1:8000/api/v1/auth/status", timeout=5) as response:  # nosec B310
        status = json.load(response)
        if (
            not isinstance(status.get("configured"), bool)
            or status.get("authenticated") is not False
        ):
            raise SystemExit("Authentication API is unavailable")
    subprocess.run(["/usr/bin/ffmpeg", "-version"], check=True, capture_output=True)
    settings = Settings()
    with TemporaryFile(dir=settings.library_dir) as probe:
        probe.write(b"managed-library-write-check")
    try:
        with TemporaryFile(dir=settings.music_dir):
            pass
    except OSError as error:
        if error.errno not in {errno.EROFS, errno.EACCES, errno.EPERM}:
            raise
    else:
        raise SystemExit("Music directory must be read-only")
    print(
        "Container smoke passed: ready, protected library API, Web UI, FFmpeg, non-root, read-only music"
    )


if __name__ == "__main__":
    main()
