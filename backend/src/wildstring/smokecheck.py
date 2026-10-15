"""Exercise the built container rather than its deployment configuration."""

import errno
import json
import os
import subprocess
from tempfile import TemporaryFile
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
    with urlopen("http://127.0.0.1:8000/api/v1/tracks?limit=1", timeout=5) as response:  # nosec B310
        page = json.load(response)
        if not isinstance(page.get("items"), list) or not isinstance(page.get("total"), int):
            raise SystemExit("Library API is unavailable")
    subprocess.run(["/usr/bin/ffmpeg", "-version"], check=True, capture_output=True)
    settings = Settings()
    try:
        with TemporaryFile(dir=settings.music_dir):
            pass
    except OSError as error:
        if error.errno not in {errno.EROFS, errno.EACCES, errno.EPERM}:
            raise
    else:
        raise SystemExit("Music directory must be read-only")
    print("Container smoke passed: ready, library API, Web UI, FFmpeg, non-root, read-only music")


if __name__ == "__main__":
    main()
