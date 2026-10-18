"""Validated ZIP packages and bounded worker processes for explicitly trusted plugins."""

import hashlib
import io
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from contextlib import suppress
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory, TemporaryFile
from urllib.parse import urlsplit
from zipfile import BadZipFile, ZipFile

from fastapi import HTTPException

from wildstring.source_plugins import Manifest, PluginError

MAX_ARCHIVE = 16 * 1024 * 1024
MAX_EXPANDED = 32 * 1024 * 1024


def inspect_package(data):
    if len(data) > MAX_ARCHIVE:
        raise HTTPException(413, "source_plugin_zip_too_large")
    try:
        archive = ZipFile(io.BytesIO(data))
        entries = archive.infolist()
        if not 1 <= len(entries) <= 300 or sum(entry.file_size for entry in entries) > MAX_EXPANDED:
            raise ValueError
        names = set()
        for entry in entries:
            path = PurePosixPath(entry.filename)
            if (
                entry.filename.casefold() in names
                or path.is_absolute()
                or ".." in path.parts
                or "\\" in entry.filename
                or ":" in entry.filename
                or not path.parts
                or str(path) != entry.filename.rstrip("/")
                or "\x00" in entry.filename
                or any(ord(c) < 32 for c in entry.filename)
                or (entry.external_attr >> 16) & 0o170000 == 0o120000
                or entry.flag_bits & 1
            ):
                raise ValueError
            names.add(entry.filename.casefold())
        files = {entry.filename for entry in entries if not entry.is_dir()}
        folded_files = {name.casefold() for name in files}
        if any(
            str(parent).casefold() in folded_files
            for entry in entries
            for parent in PurePosixPath(entry.filename).parents
        ):
            raise ValueError
        manifest_data = archive.read("manifest.json")
        if len(manifest_data) > 32_000:
            raise ValueError
        values = json.loads(manifest_data)
        if not isinstance(values, dict) or any(
            not isinstance(values.get(key), str) for key in ("id", "name", "upstream", "license")
        ):
            raise ValueError
        manifest = Manifest(**values)
        if (
            type(manifest.api_version) is not int
            or manifest.api_version != 1
            or type(manifest.request_pacing) is not bool
            or not re.fullmatch(r"[a-z][a-z0-9_-]{1,40}", manifest.id)
            or not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?", manifest.version)
            or not 1 <= len(manifest.name) <= 150
            or not 1 <= len(manifest.license) <= 100
            or len(manifest.upstream) > 2000
            or urlsplit(manifest.upstream).scheme != "https"
            or not urlsplit(manifest.upstream).hostname
            or any(ord(c) < 32 for c in manifest.name + manifest.license + manifest.upstream)
            or not re.fullmatch(
                r"[a-zA-Z_][a-zA-Z0-9_]*:[a-zA-Z_][a-zA-Z0-9_]*", manifest.entrypoint
            )
        ):
            raise ValueError
        module, _ = manifest.entrypoint.split(":")
        if not isinstance(manifest.capabilities, (list, tuple)) or not manifest.capabilities:
            raise ValueError
        if module + ".py" not in files or not set(manifest.capabilities) <= {
            "metadata",
            "lyrics",
            "cover",
        }:
            raise ValueError
        if not isinstance(manifest.requires_modules, (list, tuple)) or any(
            not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]*", name) for name in manifest.requires_modules
        ):
            raise ValueError
        if not isinstance(manifest.settings, (list, tuple)) or len(manifest.settings) > 20:
            raise ValueError
        if (
            not isinstance(manifest.cover_hosts, (list, tuple))
            or len(manifest.cover_hosts) > 10
            or any(
                not isinstance(host, str)
                or len(host) > 253
                or not re.fullmatch(r"[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+", host)
                or host.endswith((".local", ".localhost", ".internal"))
                for host in manifest.cover_hosts
            )
        ):
            raise ValueError
        if (
            not isinstance(manifest.requires_programs, (list, tuple))
            or len(manifest.requires_programs) > 10
            or any(
                not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,50}", name)
                for name in manifest.requires_programs
            )
        ):
            raise ValueError
        keys = set()
        for field in manifest.settings:
            if (
                not isinstance(field, dict)
                or not re.fullmatch(r"[a-z][a-z0-9_]{0,40}", field.get("key", ""))
                or field.get("type") not in {"text", "url", "secret"}
                or field["key"] in keys
                or not isinstance(field.get("label"), str)
                or not 1 <= len(field["label"]) <= 150
                or type(field.get("required", False)) is not bool
            ):
                raise ValueError
            keys.add(field["key"])
        # Detect corrupted entries before any package is made active.
        if archive.testzip() is not None:
            raise ValueError
        return manifest, archive
    except (
        ValueError,
        TypeError,
        KeyError,
        BadZipFile,
        UnicodeError,
        NotImplementedError,
        RuntimeError,
    ):
        raise HTTPException(422, "source_plugin_invalid_zip") from None


def install(manager, data, expected_version=None, expected_id=None):
    manifest, archive = inspect_package(data)
    if expected_id is not None and manifest.id != expected_id:
        archive.close()
        raise HTTPException(409, "source_plugin_identity_conflict")
    digest = hashlib.sha256(data).hexdigest()
    root = manager.providers.directory / "source-plugins"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = root / digest
    with archive, TemporaryDirectory(dir=root) as temporary:
        for entry in archive.infolist():
            path = Path(temporary) / entry.filename
            if entry.is_dir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(entry) as source, path.open("wb") as output:
                    shutil.copyfileobj(source, output, length=64 * 1024)
                path.chmod(0o600)
        (Path(temporary) / "package.zip").write_bytes(data)
        with manager.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute(
                "SELECT version FROM source_plugin_settings WHERE plugin_id=?", (manifest.id,)
            ).fetchone()
            if (old and expected_version != old[0]) or (not old and expected_version is not None):
                raise HTTPException(409, "source_plugin_version_conflict")
            if not target.exists():
                os.rename(temporary, target)
                # TemporaryDirectory tolerates the now-missing temporary path on exit.
            db.execute(
                "INSERT INTO source_plugin_packages VALUES (?,?,?,?) ON CONFLICT(plugin_id) DO UPDATE SET sha256=excluded.sha256,manifest=excluded.manifest,imported_at=excluded.imported_at",
                (manifest.id, digest, json.dumps(manifest.public()), time.time()),
            )
            db.execute(
                "INSERT INTO source_plugin_settings(plugin_id,version) VALUES (?,1) ON CONFLICT(plugin_id) DO UPDATE SET enabled=0,version=version+1",
                (manifest.id,),
            )
    return next(item for item in manager.catalog() if item["id"] == manifest.id)


def execute(plugin, context, method, value):
    from filelock import FileLock, Timeout

    directory = context.directory / "plugin-state"
    directory.mkdir(parents=True, exist_ok=True)
    try:
        with FileLock(str(directory / (plugin.manifest.id + ".request.lock")), timeout=2):
            return execute_serial(plugin, context, method, value)
    except Timeout:
        raise PluginError("source_plugin_busy") from None


def execute_serial(plugin, context, method, value):
    context.manager.current(context.identity, context.configuration["version"])
    cache_key = hashlib.sha256(
        json.dumps(
            [plugin.sha256, context.configuration["version"], method, value], sort_keys=True
        ).encode()
    ).hexdigest()
    with context.manager.database.connect() as db:
        cached = db.execute(
            "SELECT payload FROM provider_cache WHERE provider=? AND cache_key=? AND expires_at>?",
            ("plugin:" + plugin.manifest.id, cache_key, time.time()),
        ).fetchone()
    if cached and not context.force:
        return json.loads(cached[0])
    config = context.manager.providers.settings()
    secrets = {
        field["key"]: context.manager.providers.secrets().get(
            f"source:{context.identity}:{field['key']}"
        )
        for field in plugin.manifest.settings
        if field["type"] == "secret"
    }
    payload = {
        "path": str(plugin.path.resolve()),
        "entrypoint": plugin.manifest.entrypoint,
        "method": method,
        "value": value,
        "config": context.configuration["config"],
        "secrets": secrets,
        "proxy_mode": config["proxy_mode"],
        "proxy_url": context.manager.providers.secrets().get("proxy_url"),
        "directory": str((context.directory / "plugin-state" / plugin.manifest.id).resolve()),
        "rate": {
            "database": str(context.manager.database.path.resolve()),
            "plugin_id": plugin.manifest.id,
            "interval_seconds": context.interval_seconds,
            "batch_id": context.batch_id,
        },
    }
    if not plugin.manifest.request_pacing:
        from wildstring.plugin_rate import wait

        wait(payload["rate"], context.deadline)
        payload["rate"] = None
    remaining = min(
        60 if not context.batch_id else 50 + context.interval_seconds * 8,
        context.deadline - time.monotonic(),
    )
    if remaining <= 0:
        raise PluginError("source_plugin_timeout")
    with TemporaryFile() as source, TemporaryFile() as output:
        source.write(json.dumps(payload).encode())
        source.seek(0)
        try:
            process = subprocess.Popen(
                [sys.executable, "-I", "-m", "wildstring.plugin_worker"],
                stdin=source,
                stdout=output,
                stderr=subprocess.DEVNULL,
                start_new_session=os.name == "posix",
                env={
                    key: value
                    for key, value in os.environ.items()
                    if key
                    in {
                        "PATH",
                        "SYSTEMROOT",
                        "SSL_CERT_FILE",
                        "SSL_CERT_DIR",
                        "HTTP_PROXY",
                        "HTTPS_PROXY",
                        "ALL_PROXY",
                        "NO_PROXY",
                        "http_proxy",
                        "https_proxy",
                        "all_proxy",
                        "no_proxy",
                    }
                },
            )
            try:
                end = time.monotonic() + remaining
                while process.poll() is None:
                    if context.batch_id and context.manager.scans.exit.is_set():
                        raise PluginError("lyric_scan_paused")
                    budget = end - time.monotonic()
                    if budget <= 0:
                        raise subprocess.TimeoutExpired("plugin_worker", remaining)
                    try:
                        process.wait(timeout=min(0.25, budget))
                    except subprocess.TimeoutExpired:
                        continue
            finally:
                if os.name == "posix":
                    with suppress(ProcessLookupError):
                        os.killpg(process.pid, signal.SIGKILL)
                elif process.poll() is None:
                    process.kill()
                process.wait()
        except subprocess.TimeoutExpired:
            raise PluginError("source_plugin_timeout") from None
        if process.returncode or output.tell() > 2 * 1024 * 1024:
            raise PluginError("source_plugin_worker_failed")
        output.seek(0)
        try:
            result = json.load(output)
        except ValueError:
            raise PluginError("source_plugin_invalid_response") from None
    context.manager.current(context.identity, context.configuration["version"])
    if not isinstance(result, dict) or "value" not in result:
        code = result.get("error", "") if isinstance(result, dict) else ""
        raise PluginError(
            code if re.fullmatch(r"[a-z0-9_:-]{1,100}", code) else "source_plugin_worker_failed"
        )
    with context.manager.database.connect(write=True) as db:
        db.execute("DELETE FROM provider_cache WHERE expires_at<?", (time.time(),))
        size = db.execute(
            "SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) FROM provider_cache"
        ).fetchone()[0]
        if size > 20_000_000:
            db.execute("DELETE FROM provider_cache")
        db.execute(
            "INSERT OR REPLACE INTO provider_cache VALUES (?,?,?,?)",
            (
                "plugin:" + plugin.manifest.id,
                cache_key,
                json.dumps(result["value"]),
                time.time() + 1800,
            ),
        )
    return result["value"]
