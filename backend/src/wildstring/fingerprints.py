"""Bounded, read-only Chromaprint extraction from an already opened managed file."""

import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from tempfile import TemporaryFile

from wildstring.library.scanner import fingerprint, open_source


class FingerprintError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def valid_result(result):
    if not isinstance(result, dict):
        raise ValueError("Invalid fingerprint")
    duration, value = result.get("duration"), result.get("fingerprint")
    if (
        isinstance(duration, bool)
        or not isinstance(duration, int | float)
        or not math.isfinite(duration)
        or not 1 <= duration <= 172800
        or not isinstance(value, str)
        or not re.fullmatch(r"[A-Za-z0-9_-]{10,64000}={0,2}", value)
    ):
        raise ValueError("Invalid fingerprint")
    return {"duration": int(duration), "fingerprint": value}


def calculate(repository, track_id, stopping):
    record = repository.source(track_id)
    if record is None or record["status"] != "available":
        raise FingerprintError("fingerprint_source_unavailable")
    process = None
    try:
        with open_source(repository.root, Path(record["path"])) as source:
            before = os.fstat(source.fileno())
            if (before.st_size, before.st_mtime_ns) != (record["size_bytes"], record["mtime_ns"]):
                raise FingerprintError("fingerprint_source_changed")
            key = hashlib.sha256(
                json.dumps(["chromaprint-v1-120s", *fingerprint(before)]).encode()
            ).hexdigest()
            with repository.database.connect() as connection:
                cached = connection.execute(
                    "SELECT payload FROM provider_cache WHERE provider='chromaprint' AND cache_key=? AND expires_at>?",
                    (key, time.time()),
                ).fetchone()
            if cached:
                return valid_result(json.loads(cached[0]))
            tool = shutil.which("fpcalc")
            if not tool:
                raise FingerprintError("fingerprint_tool_missing")
            if os.name != "posix":
                raise FingerprintError("fingerprint_platform_unsupported")
            # Passing a held file descriptor preserves seeking (notably MP4), while avoiding
            # shell interpolation, symlink races and re-opening an arbitrary pathname.
            with TemporaryFile() as output:
                process = subprocess.Popen(
                    [tool, "-json", "-length", "120", f"/dev/fd/{source.fileno()}"],
                    stdout=output,
                    stderr=subprocess.DEVNULL,
                    pass_fds=(source.fileno(),),
                )
                deadline = time.monotonic() + 90
                while process.poll() is None:
                    if stopping.wait(0.2):
                        raise FingerprintError("worker_stopped")
                    if time.monotonic() > deadline:
                        raise FingerprintError("fingerprint_timeout")
                if process.returncode != 0:
                    raise FingerprintError("fingerprint_failed")
                if output.tell() > 65536:
                    raise FingerprintError("fingerprint_invalid_output")
                output.seek(0)
                result = valid_result(json.load(output))
            if fingerprint(os.fstat(source.fileno())) != fingerprint(before):
                raise FingerprintError("fingerprint_source_changed")
            with repository.database.connect(write=True) as connection:
                connection.execute("DELETE FROM provider_cache WHERE expires_at<?", (time.time(),))
                if (
                    connection.execute(
                        "SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) FROM provider_cache"
                    ).fetchone()[0]
                    > 20_000_000 - 65536
                ):
                    connection.execute("DELETE FROM provider_cache")
                connection.execute(
                    "INSERT OR REPLACE INTO provider_cache VALUES ('chromaprint',?,?,?)",
                    (key, json.dumps(result), time.time() + 86400),
                )
            return result
    except FingerprintError:
        raise
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        raise FingerprintError("fingerprint_failed") from None
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait()
