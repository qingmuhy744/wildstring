"""Bounded public-source lookups. All results are suggestions, never file writes."""

import gzip
import hashlib
import json
import logging
import math
import os
import re
import secrets
import shutil
import sqlite3
import threading
import time
from contextlib import contextmanager, suppress
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Annotated, Literal
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import (
    HTTPRedirectHandler,
    Request,
    build_opener,
    getproxies_environment,
)
from uuid import UUID, uuid4

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse, Response
from filelock import FileLock, Timeout
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from wildstring.diagnostics import record_event, trace_context
from wildstring.fingerprints import FingerprintError, calculate
from wildstring.library.edits import MetadataEditor, MetadataUpdate, Overrides
from wildstring.outbound import OutboundError, network_error, request_bytes, validate_proxy
from wildstring.provider_network import (
    NetworkTest,
    test_network,
)
from wildstring.provider_tasks import (
    RETENTION_DAYS,
    HistoryClear,
    ReviewTasks,
    View,
    clear_history,
    retry_task,
    review_tasks,
    task_page,
)
from wildstring.task_notifications import metadata_result

MB = "https://musicbrainz.org/ws/2/"
FM = "https://ws.audioscrobbler.com/2.0/"
ACOUSTID = "https://api.acoustid.org/v2/lookup"
UA = "WildString/0.3.3 (https://github.com/qingmuhy744/wildstring)"
logger = logging.getLogger(__name__)


def plugin_cover(value, hosts=()):
    try:
        parsed = urlsplit(value or "")
        host = parsed.hostname or ""
        if (
            parsed.scheme in {"http", "https"}
            and parsed.port in {None, 80, 443}
            and not parsed.username
            and not parsed.password
            and not parsed.fragment
            and not any(ord(c) < 32 for c in value)
            and any(host == domain or host.endswith("." + domain) for domain in hosts)
        ):
            return (
                "https://"
                + parsed.netloc.split(":")[0]
                + parsed.path
                + ("?" + parsed.query if parsed.query else "")
            )
    except ValueError:
        return None
    return None


@contextmanager
def request_lock(path, timeout_limit):
    """Interactive queries can shorten the entire provider wait, including its lock."""
    started = time.monotonic()
    try:
        with FileLock(str(path), timeout=timeout_limit if timeout_limit is not None else -1):
            yield started + timeout_limit if timeout_limit is not None else None
    except Timeout:
        raise ProviderError("provider_request_timeout") from None


def missing_fields(track, manual, fields):
    result = {}
    for key, value in fields.items():
        if key in manual:
            continue
        current = track.get(key)
        if key == "external_ids" and current:
            if (
                current.get("recording")
                and value.get("recording")
                and current["recording"] != value["recording"]
            ):
                continue
            additions = {name: item for name, item in value.items() if not current.get(name)}
            if additions:
                result[key] = current | additions
        elif not current or (key == "title" and track.get("title_source") == "filename"):
            result[key] = value
    return result


class ProviderError(Exception):
    def __init__(self, code="provider_unavailable", transient=True, http_status=None):
        self.http_status = http_status
        self.code, self.transient = code, transient
        super().__init__(code)


class SafeRedirect(HTTPRedirectHandler):
    def __init__(self, cover_hosts=()):
        super().__init__()
        self.cover_hosts = cover_hosts

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urlsplit(newurl)
        allowed = (
            bool(plugin_cover(newurl, self.cover_hosts))
            or parsed.hostname in {"coverartarchive.org", "archive.org"}
            or (parsed.hostname or "").endswith(".archive.org")
        )
        if (
            parsed.scheme != "https"
            or not allowed
            or parsed.port not in (None, 443)
            or parsed.username
            or parsed.password
        ):
            raise ProviderError("unsafe_cover_redirect", False)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def lastfm_signature(parameters, secret):
    raw = (
        "".join(
            key + str(parameters[key])
            for key in sorted(parameters)
            if key not in {"format", "callback"}
        )
        + secret
    )
    # Last.fm requires MD5 for api_sig. Keep this legacy protocol isolated;
    # do not reuse it for password storage or general-purpose authentication.
    return hashlib.md5(raw.encode(), usedforsecurity=False).hexdigest()


def lastfm_failure(payload, method):
    code = int(payload["error"])
    if code == 6 and method == "track.getInfo" and payload.get("message") == "Track not found":
        return ProviderError("lastfm_track_not_found", False)
    return ProviderError(
        "lastfm_reauthorize" if code == 9 else f"lastfm_error_{code}",
        code in {8, 11, 16, 29},
    )


def acoustid_failure(payload):
    error = payload.get("error")
    code = error.get("code") if isinstance(error, dict) else None
    if type(code) is int and 0 <= code <= 999:
        return ProviderError(f"acoustid_error_{code}", code in {5, 13, 14})
    return ProviderError("acoustid_rejected", False)


class Providers:
    def __init__(self, repository):
        self.repository, self.database = repository, repository.database
        self.directory = self.database.path.parent / "providers"
        self.credentials = self.directory / ".env"
        self.exit = threading.Event()
        self.thread = None
        self.storage_identity = None
        self.history_cleaned_at = 0.0
        self.network_test_lock = threading.Lock()
        from wildstring.music_sources import MusicSources

        self.sources = MusicSources(self)
        from wildstring.loudness import Loudness

        self.loudness = Loudness(repository, self.exit)
        self.worker_lock = FileLock(
            str(self.directory / "worker.lock"), timeout=0, thread_local=False
        )

    def check_storage(self):
        if self.storage_identity is not None:
            info = self.database.path.parent.stat()
            if (
                info.st_dev,
                info.st_ino,
            ) != self.storage_identity or not self.database.path.is_file():
                raise OSError("provider_storage_changed")

    def secrets(self, update=None):
        self.check_storage()
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        with FileLock(str(self.directory / "credentials.lock")):
            values = json.loads(self.credentials.read_text()) if self.credentials.exists() else {}
            if update is not None:
                values.update(update)
                values = {key: value for key, value in values.items() if value is not None}
                with NamedTemporaryFile(mode="w", dir=self.directory, delete=False) as stream:
                    temporary = Path(stream.name)
                    try:
                        os.chmod(temporary, 0o600)
                        json.dump(values, stream)
                        stream.flush()
                        os.fsync(stream.fileno())
                        temporary.replace(self.credentials)
                    finally:
                        temporary.unlink(missing_ok=True)
            return values

    def settings(self):
        with self.database.connect() as connection:
            config = dict(
                connection.execute("SELECT * FROM provider_settings WHERE id=1").fetchone()
            )
        config.pop("id", None)
        for flag in ("enabled", "auto_new", "musicbrainz", "lastfm", "caa", "acoustid"):
            config[flag] = bool(config[flag])
        config["priority"] = json.loads(config["priority"])
        config["acoustid_configured"] = bool(self.secrets().get("acoustid_api_key"))
        config["fingerprint_available"] = shutil.which("fpcalc") is not None
        config["lastfm_configured"] = bool(
            self.secrets().get("api_key") and self.secrets().get("api_secret")
        )
        config["proxy_configured"] = bool(self.secrets().get("proxy_url"))
        config["environment_proxy_configured"] = any(
            getproxies_environment().get(key) for key in ("http", "https", "all")
        )
        return config

    def request(
        self,
        url,
        parameters=None,
        *,
        signed=False,
        image=False,
        proxy_mode=None,
        proxy_url=None,
        diagnostic=False,
        timeout_limit=None,
    ):
        timeout_limit = min(15, max(0.01, timeout_limit)) if timeout_limit is not None else None
        parameters = dict(parameters or {})
        if url == FM:
            credentials = self.secrets()
            if not credentials.get("api_key") or (signed and not credentials.get("api_secret")):
                raise ProviderError("lastfm_not_configured", False)
            parameters["api_key"] = credentials["api_key"]
            if signed:
                parameters["api_sig"] = lastfm_signature(parameters, credentials["api_secret"])
            parameters["format"] = "json"
        if url == ACOUSTID:
            key = self.secrets().get("acoustid_api_key")
            if not key:
                raise ProviderError("acoustid_not_configured", False)
            parameters.update(client=key, format="json")
        provider = (
            "acoustid"
            if url == ACOUSTID
            else "lastfm"
            if url == FM
            else "musicbrainz"
            if url.startswith(MB)
            else "caa"
        )
        post = url == ACOUSTID or (
            signed and parameters.get("method") in {"track.scrobble", "track.updateNowPlaying"}
        )
        data = urlencode(parameters).encode() if post else None
        if url == ACOUSTID:
            data = gzip.compress(data)
        address = url + (("?" + urlencode(parameters)) if parameters and not post else "")
        # Shared across worker processes. Never hold a SQLite transaction while doing network I/O.
        with request_lock(self.directory / f"{provider}.lock", timeout_limit) as deadline:
            with self.database.connect() as connection:
                previous = connection.execute(
                    "SELECT called_at FROM provider_limits WHERE provider=?", (provider,)
                ).fetchone()
            delay = max(0, 1.05 - (time.time() - previous[0])) if previous else 0
            if deadline is not None and delay >= deadline - time.monotonic():
                raise ProviderError("provider_request_timeout")
            if diagnostic:
                time.sleep(delay)
            elif self.exit.wait(delay):
                raise ProviderError("worker_stopped")
            with self.database.connect(write=True) as connection:
                connection.execute(
                    "INSERT OR REPLACE INTO provider_limits VALUES (?,?)", (provider, time.time())
                )
            try:
                req = Request(
                    address,
                    data=data,
                    headers={
                        "User-Agent": UA,
                        "Accept": "image/*" if image else "application/json",
                        **(
                            {
                                "Content-Type": "application/x-www-form-urlencoded",
                                "Content-Encoding": "gzip",
                            }
                            if url == ACOUSTID
                            else {}
                        ),
                    },
                )
                mode = proxy_mode if proxy_mode is not None else self.settings()["proxy_mode"]
                proxy = proxy_url if proxy_mode is not None else self.secrets().get("proxy_url")
                try:
                    _, _, raw = request_bytes(
                        req,
                        proxy_mode=mode,
                        proxy_url=proxy,
                        timeout=max(0.01, deadline - time.monotonic())
                        if deadline is not None
                        else 15,
                        limit=8 * 1024 * 1024 if image else 2 * 1024 * 1024,
                        redirect=SafeRedirect(self.cover_hosts()) if provider == "caa" else None,
                        opener_factory=build_opener,
                        service=provider,
                    )
                except OutboundError as error:
                    raise ProviderError(
                        "provider_response_too_large"
                        if error.code == "response_too_large"
                        else error.code,
                        http_status=error.http_status,
                    ) from None
                result = raw if image else json.loads(raw)
                if not image and not isinstance(result, dict):
                    raise ProviderError("provider_invalid_response")
                if url == ACOUSTID and result.get("status") != "ok":
                    raise acoustid_failure(result)
                if url == FM and "error" in result:
                    raise lastfm_failure(result, parameters.get("method"))
                return result
            except HTTPError as error:
                # Music APIs can return structured errors with a non-2xx status.
                # Keep only the numeric code, never the raw message or signed request URL.
                failure = None
                try:
                    if url == FM:
                        payload = json.loads(error.read(2 * 1024 * 1024 + 1))
                        failure = lastfm_failure(payload, parameters.get("method"))
                    elif url == ACOUSTID:
                        payload = json.loads(error.read(2 * 1024 * 1024 + 1))
                        if isinstance(payload, dict):
                            failure = acoustid_failure(payload)
                except (ValueError, TypeError, KeyError):
                    failure = None
                except (URLError, TimeoutError, OSError) as failure:
                    raise ProviderError(network_error(failure)) from None
                finally:
                    error.close()
                if failure is not None:
                    failure.http_status = error.code
                    raise failure from None
                raise ProviderError(
                    "provider_not_found"
                    if error.code == 404
                    else "proxy_auth_required"
                    if error.code == 407
                    else "provider_http_error",
                    error.code in {429, 500, 502, 503, 504},
                    http_status=error.code,
                ) from None
            except (URLError, TimeoutError, OSError) as error:
                raise ProviderError(network_error(error)) from None
            except ValueError:
                raise ProviderError("provider_invalid_response") from None

    def cover_hosts(self):
        return tuple(
            {
                host
                for plugin in self.sources.plugins.values()
                for host in plugin.manifest.cover_hosts
            }
        )

    def cover_data(self, url, **network):
        """Use the configured server proxy and the same image guards for preview and apply."""
        from wildstring.library.assets import TrackAssets

        try:
            parsed = urlsplit(url)
            valid = plugin_cover(url, self.cover_hosts()) or (
                parsed.scheme in {"http", "https"}
                and parsed.hostname == "coverartarchive.org"
                and parsed.port in (None, 80, 443)
                and not parsed.username
                and not parsed.password
                and not parsed.query
                and not parsed.fragment
                and re.fullmatch(
                    r"/release/[0-9a-f-]{36}/[0-9]+(?:-[0-9]+)?\.(?:jpg|png)", parsed.path
                )
            )
        except ValueError:
            valid = False
        if not valid:
            raise HTTPException(422, "invalid_cover_url")
        try:
            data = self.request(
                plugin_cover(url, self.cover_hosts())
                or "https://coverartarchive.org" + parsed.path,
                image=True,
                **network,
            )
            thumbnail = TrackAssets(self.repository).thumbnail(data, 768)
            if thumbnail is None:
                raise ProviderError("invalid_cover", False)
            return data, thumbnail
        except ProviderError:
            raise HTTPException(502, "cover_download_failed") from None

    def cached(self, provider, key, url, parameters=None, *, force=False):
        digest = hashlib.sha256(key.encode()).hexdigest()
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT payload FROM provider_cache WHERE provider=? AND cache_key=? AND expires_at>?",
                (provider, digest, time.time()),
            ).fetchone()
        if row and not force:
            return json.loads(row[0])
        result = self.request(url, parameters)
        payload = json.dumps(result, ensure_ascii=False)
        with self.database.connect(write=True) as connection:
            connection.execute("DELETE FROM provider_cache WHERE expires_at<?", (time.time(),))
            # Keep the whole cache well below Last.fm's storage allowance.
            if (
                connection.execute(
                    "SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) FROM provider_cache"
                ).fetchone()[0]
                + len(payload.encode())
                > 20_000_000
            ):
                connection.execute("DELETE FROM provider_cache")
            connection.execute(
                "INSERT OR REPLACE INTO provider_cache VALUES (?,?,?,?)",
                (provider, digest, payload, time.time() + 86400),
            )
        return result

    def enqueue(
        self,
        track_ids=None,
        *,
        scope=None,
        identity=None,
        mode="all",
        force=False,
        track_batch=False,
    ):
        from wildstring.provider_batches import record_batch

        config = self.settings()
        if not config["enabled"]:
            raise HTTPException(409, "providers_disabled")
        ids = list(dict.fromkeys(track_ids or []))
        library_id = self.repository.library_id(create=track_batch)
        batch_id = None
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            sql = "SELECT t.id,t.title,m.version FROM track_metadata m JOIN tracks t ON t.id=m.track_id WHERE t.library_id=? AND t.status='available'"
            parameters = [library_id]
            if scope == "album":
                sql += " AND t.album_id=?"
                parameters.append(identity)
            elif scope == "track":
                sql += " AND t.id=?"
                parameters.append(identity)
            elif scope != "library":
                if not ids:
                    result = {"queued": 0, "already_active": 0, "total": 0}
                    if track_batch:
                        result["batch_id"] = record_batch(connection, library_id, [])
                    return result
                sql += " AND t.id IN (" + ",".join("?" for _ in ids) + ")"
                parameters.extend(ids)
            rows = connection.execute(sql, parameters).fetchall()
            if (scope in {"album", "track"} and not rows) or (
                scope is None and len(rows) != len(ids)
            ):
                raise HTTPException(404, "track_not_found")
            before = connection.total_changes
            clock = time.time()
            connection.executemany(
                "INSERT OR IGNORE INTO provider_jobs(id,track_id,metadata_version,status,created_at,updated_at,refresh_mode,force) VALUES (?,?,?,'queued',?,?,?,?)",
                [
                    (uuid4().hex, row["id"], row["version"], clock, clock, mode, force)
                    for row in rows
                ],
            )
            added = connection.total_changes - before
            connection.executemany(
                "INSERT OR IGNORE INTO provider_seen VALUES (?)", [(row["id"],) for row in rows]
            )
            if track_batch:
                batch_id = record_batch(connection, library_id, rows)
        result = {"queued": added, "already_active": len(rows) - added, "total": len(rows)}
        if batch_id is not None:
            result["batch_id"] = batch_id
        record_event("provider.tasks.queued", count=added, batch_id=batch_id)
        return result

    def identify(self, track, *, force=False):
        audio = calculate(self.repository, track["id"], self.exit)
        result = self.cached(
            "acoustid",
            json.dumps(audio, sort_keys=True),
            ACOUSTID,
            audio | {"meta": "recordingids"},
            force=force,
        )
        matches = {}
        for item in result.get("results", [])[:30]:
            score = item.get("score")
            if (
                isinstance(score, bool)
                or not isinstance(score, int | float)
                or not math.isfinite(score)
                or not 0.7 <= score <= 1
            ):
                continue
            try:
                acoustid = str(UUID(item["id"]))
                for recording in item.get("recordings", [])[:30]:
                    identity = str(UUID(recording["id"]))
                    if score > matches.get(identity, {}).get("match", {}).get("score", -1):
                        matches[identity] = {
                            "id": identity,
                            "match": {
                                "method": "acoustid",
                                "score": score,
                                "acoustid_id": acoustid,
                            },
                        }
            except (KeyError, ValueError, TypeError, AttributeError):
                continue
        return sorted(matches.values(), key=lambda item: item["match"]["score"], reverse=True)[:3]

    def suggestions(self, track, *, force=False):
        output, warnings = [], []
        config = self.settings()
        local_cover = bool(track.get("has_cover"))
        if config["caa"] and not local_cover:
            from wildstring.library.assets import TrackAssets

            with suppress(HTTPException):
                local_cover = TrackAssets(self.repository).cover(track["id"], 96) is not None
        if config["musicbrainz"]:
            recordings = []
            if config["acoustid"]:
                try:
                    recordings = self.identify(track, force=force)
                except (
                    ProviderError,
                    FingerprintError,
                    KeyError,
                    TypeError,
                    ValueError,
                    AttributeError,
                ) as error:
                    warnings.append(
                        error.code
                        if isinstance(error, ProviderError | FingerprintError)
                        else "acoustid_invalid_response"
                    )
            try:
                identity = track.get("external_ids", {}).get("recording")
                if not recordings and identity:
                    recordings = [{"id": str(UUID(identity))}]
                elif not recordings:

                    def escape(text):
                        return re.sub(r'([+\-!(){}\[\]^"~*?:\\/]|&&|\|\|)', r"\\\1", text)

                    query = f'recording:"{escape(track["title"])}"'
                    if track["artists"]:
                        query += f' AND artist:"{escape(track["artists"][0])}"'
                    recordings = self.cached(
                        "musicbrainz",
                        query,
                        MB + "recording",
                        {"query": query, "limit": 3, "fmt": "json"},
                        force=force,
                    ).get("recordings", [])
                for item in recordings[:3]:
                    recording = self.cached(
                        "musicbrainz",
                        item["id"],
                        MB + f"recording/{UUID(item['id'])}",
                        {
                            "inc": "artists artist-rels work-rels work-level-rels releases",
                            "fmt": "json",
                        },
                        force=force,
                    )
                    credits = recording.get("artist-credit", [])
                    fields = {
                        "title": recording["title"],
                        "artists": [c["artist"]["name"] for c in credits if isinstance(c, dict)],
                        "artist_credit": "".join(
                            c.get("name", c.get("artist", {}).get("name", ""))
                            + c.get("joinphrase", "")
                            for c in credits
                            if isinstance(c, dict)
                        ),
                        "external_ids": {"recording": recording["id"]},
                    }
                    roles = {
                        "composer": "composers",
                        "lyricist": "lyricists",
                        "arranger": "arrangers",
                        "vocal": "vocalists",
                    }
                    relations = list(recording.get("relations", []))
                    for relation in recording.get("relations", []):
                        relations.extend(relation.get("work", {}).get("relations", []))
                    for relation in relations:
                        role = roles.get(relation.get("type"))
                        if role and relation.get("artist", {}).get("name"):
                            fields.setdefault(role, []).append(relation["artist"]["name"])
                    release_id = track.get("external_ids", {}).get("release")
                    releases = recording.get("releases", [])
                    # An embedded release ID is a hint, not a filter: downloaded tags may
                    # point at a different recording or an unrelated pressing entirely.
                    releases = sorted(releases, key=lambda release: release.get("id") != release_id)
                    # Keep different releases separate; never silently pick the first pressing.
                    for release in releases[:3] or [None]:
                        candidate = json.loads(json.dumps(fields))
                        cover = None
                        if release:
                            candidate["album"] = release["title"]
                            candidate["external_ids"]["release"] = release["id"]
                            from wildstring.library.tag_fields import valid_date

                            if valid_date(release.get("date")):
                                candidate["release_date"] = release["date"]
                            if config["caa"] and not local_cover:
                                with suppress(ProviderError):
                                    art = self.cached(
                                        "caa",
                                        release["id"],
                                        f"https://coverartarchive.org/release/{UUID(release['id'])}",
                                        force=force,
                                    )
                                    cover = next(
                                        (
                                            i.get("image")
                                            for i in art.get("images", [])
                                            if i.get("front")
                                        ),
                                        None,
                                    )
                        output.append(
                            (
                                "musicbrainz",
                                f"https://musicbrainz.org/recording/{recording['id']}",
                                candidate,
                                cover,
                                item.get("match", {}),
                            )
                        )
            except (ProviderError, KeyError, TypeError, ValueError, AttributeError) as error:
                warnings.append(
                    error.code
                    if isinstance(error, ProviderError)
                    else "musicbrainz_invalid_response"
                )
        if config["lastfm"] and config["lastfm_configured"] and track["artists"]:
            try:
                params = {
                    "method": "track.getInfo",
                    "artist": track["artists"][0],
                    "track": track["title"],
                    "autocorrect": 0,
                }
                result = self.cached(
                    "lastfm", json.dumps(params, sort_keys=True), FM, params, force=force
                ).get("track", {})
                fields = {
                    "tags": [tag["name"] for tag in result.get("toptags", {}).get("tag", [])][:50]
                }
                if result.get("wiki", {}).get("summary"):
                    fields["description"] = re.sub("<[^>]+>", "", result["wiki"]["summary"])[:4096]
                output.append(
                    (
                        "lastfm",
                        "https://www.last.fm/music/"
                        + quote(track["artists"][0], safe="")
                        + "/_/"
                        + quote(track["title"], safe=""),
                        fields,
                        None,
                        {},
                    )
                )
            except (ProviderError, KeyError, TypeError, ValueError, AttributeError) as error:
                if not isinstance(error, ProviderError) or error.code != "lastfm_track_not_found":
                    warnings.append(
                        error.code
                        if isinstance(error, ProviderError)
                        else "lastfm_invalid_response"
                    )
        plugin_output, plugin_warnings = self.sources.suggestions(track)
        output.extend(plugin_output)
        warnings.extend(plugin_warnings)
        priority = self.source_priority()
        output.sort(
            key=lambda item: priority.index(item[0]) if item[0] in priority else len(priority)
        )
        return output, warnings

    def source_priority(self):
        return [value["id"] for value in self.sources.catalog()] + self.settings()["priority"]

    def process_job(self, job):
        track = self.repository.track(job["track_id"])
        if track is None:
            raise ProviderError("track_not_found", False)
        suggestions, warnings = self.suggestions(track, force=bool(job["force"]))
        manual = MetadataEditor(self.repository).read(job["track_id"])["overrides"]
        with self.database.connect(write=True) as connection:
            version = connection.execute(
                "SELECT version FROM track_metadata WHERE track_id=?", (job["track_id"],)
            ).fetchone()[0]
            if version != job["metadata_version"]:
                status = "stale"
            else:
                saved = 0
                for source, url, fields, cover, match in suggestions:
                    if job["refresh_mode"] == "missing":
                        fields = missing_fields(track, manual, fields)
                    if not fields and not cover:
                        continue
                    if cover:
                        public_cover = plugin_cover(cover, self.cover_hosts())
                        parsed = urlsplit(cover)
                        if public_cover:
                            cover = public_cover
                        elif (
                            parsed.hostname != "coverartarchive.org"
                            or parsed.scheme not in {"http", "https"}
                            or not re.fullmatch(
                                r"/release/[0-9a-f-]{36}/[0-9]+(?:-[0-9]+)?\.(?:jpg|png)",
                                parsed.path,
                            )
                        ):
                            cover = None
                        else:
                            cover = "https://coverartarchive.org" + parsed.path
                    validated = Overrides.model_validate(fields).model_dump(exclude_unset=True)
                    match = dict(match or {})
                    from wildstring.album_release_locks import candidate_conflict

                    conflict = candidate_conflict(
                        connection,
                        self.repository.library_id(),
                        track["album_id"],
                        {
                            "provider": source,
                            "match": json.dumps(match),
                            "fields": json.dumps(validated),
                        },
                        set(validated),
                    )
                    if conflict:
                        match["album_release_lock"] = conflict
                    connection.execute(
                        "INSERT INTO metadata_suggestions(id,job_id,track_id,metadata_version,provider,source_url,fields,cover_url,created_at,match) VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (
                            uuid4().hex,
                            job["id"],
                            job["track_id"],
                            version,
                            source,
                            url,
                            json.dumps(validated, ensure_ascii=False),
                            cover,
                            time.time(),
                            json.dumps(match),
                        ),
                    )
                    saved += 1
                status = "completed" if saved else "failed" if warnings else "no_match"
            connection.execute(
                "UPDATE provider_jobs SET status=?,warnings=?,updated_at=? WHERE id=?",
                (status, json.dumps(warnings), time.time(), job["id"]),
            )
            metadata_result(self, connection, job["id"])

    def start(self):
        info = self.database.path.parent.stat()
        self.storage_identity = (info.st_dev, info.st_ino)
        self.secrets()
        try:
            self.worker_lock.acquire()
        except Timeout:
            return
        self.exit.clear()
        self.thread = threading.Thread(target=self.run, daemon=True, name="providers")
        self.thread.start()

    def stop(self):
        self.exit.set()
        self.sources.scans.stop()
        if self.thread:
            self.thread.join(timeout=20)

    def run(self):
        try:
            if self.worker_lock.is_locked:
                with self.database.connect(write=True) as connection:
                    connection.execute(
                        "UPDATE provider_jobs SET status='queued' WHERE status='running'"
                    )
                    connection.execute(
                        "UPDATE lyric_lookup_jobs SET status='queued' WHERE status='running' AND id NOT IN (SELECT job_id FROM lyric_scan_items WHERE job_id IS NOT NULL)"
                    )
                    connection.execute(
                        "UPDATE loudness_analysis SET status='queued' WHERE status='running'"
                    )
                    connection.execute(
                        "UPDATE lastfm_outbox SET status=CASE WHEN kind='now_playing' THEN 'cancelled' ELSE 'queued' END WHERE status='sending'"
                    )
                self.sources.scans.start()
                while not self.exit.wait(1):
                    try:
                        self.step()
                    except (
                        OSError,
                        sqlite3.Error,
                        ValueError,
                        KeyError,
                        TypeError,
                        ProviderError,
                    ) as failure:
                        record_event(
                            "provider.worker.failed",
                            level="WARNING",
                            sink=getattr(self, "diagnostics", None),
                            exception_type=type(failure).__name__,
                            code=getattr(failure, "code", "provider_worker_failed"),
                        )
                        continue
        except (OSError, sqlite3.Error) as failure:
            record_event(
                "provider.worker.stopped",
                level="ERROR",
                sink=getattr(self, "diagnostics", None),
                exception_type=type(failure).__name__,
                code="provider_storage_unavailable",
            )
        finally:
            self.sources.scans.stop()
            self.worker_lock.release()

    def step(self):
        self.check_storage()
        if self.sources.step():
            return
        if self.loudness.step():
            return
        clock = time.time()
        if clock - self.history_cleaned_at >= 3600:
            clear_history(self.repository, clock - RETENTION_DAYS * 86400)
            self.history_cleaned_at = clock
        config = self.settings()
        if not config["enabled"]:
            return
        with self.database.connect(write=True) as connection:
            connection.execute(
                "DELETE FROM lastfm_outbox WHERE status IN ('sent','cancelled','failed') AND updated_at<?",
                (time.time() - 30 * 86400,),
            )
        if config["auto_new"]:
            with self.database.connect() as connection:
                unseen = [
                    row[0]
                    for row in connection.execute(
                        "SELECT t.id FROM tracks t LEFT JOIN provider_seen s ON s.track_id=t.id WHERE s.track_id IS NULL AND t.status='available' LIMIT 20"
                    )
                ]
            if unseen:
                self.enqueue(unseen)
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            job = connection.execute(
                "SELECT * FROM provider_jobs WHERE status='queued' ORDER BY created_at LIMIT 1"
            ).fetchone()
            if job:
                connection.execute(
                    "UPDATE provider_jobs SET status='running',updated_at=? WHERE id=?",
                    (time.time(), job["id"]),
                )
        if job:
            try:
                with trace_context(
                    job["id"].replace("-", ""),
                    task_id=job["id"],
                    sink=getattr(self, "diagnostics", None),
                ):
                    record_event("provider.task.started")
                    self.process_job(job)
                    with self.database.connect() as connection:
                        finished = connection.execute(
                            "SELECT status,error FROM provider_jobs WHERE id=?", (job["id"],)
                        ).fetchone()
                    record_event(
                        "provider.task.finished", stage=finished["status"], code=finished["error"]
                    )
            except (ProviderError, ValueError, TypeError, KeyError, AttributeError):
                with self.database.connect(write=True) as connection:
                    connection.execute(
                        "UPDATE provider_jobs SET status='failed',error='provider_unavailable',updated_at=? WHERE id=?",
                        (time.time(), job["id"]),
                    )
                    metadata_result(self, connection, job["id"])
        self.deliver()

    def enqueue_listening(self, connection, user_id, session, track, accepted, playing):
        if not connection.execute("SELECT enabled FROM provider_settings WHERE id=1").fetchone()[0]:
            return
        user = connection.execute(
            "SELECT * FROM lastfm_users WHERE user_id=? AND needs_auth=0", (user_id,)
        ).fetchone()
        if user is None or not track["artists"]:
            return
        # Old reports and pre-consent listening are never uploaded automatically.
        started = session["client_started_at"] or session["started_at"]
        if started < user["enabled_since"] - 1:
            return
        artists = json.loads(track["artists"])
        if not artists:
            return
        payload = {
            "artist": artists[0],
            "track": track["title"],
            "duration": int(track["duration_ms"] / 1000),
            "timestamp": int(started),
        }
        if track["album"]:
            payload["album"] = track["album"]
        for kind, enabled in (
            ("now_playing", user["now_playing"] and playing and time.time() - started < 60),
            (
                "scrobble",
                user["scrobble"]
                and track["duration_ms"] > 30000
                and accepted >= min(track["duration_ms"] / 2, 240000),
            ),
        ):
            if enabled:
                connection.execute(
                    "INSERT OR IGNORE INTO lastfm_outbox(id,user_id,credential_ref,session_id,kind,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
                    (
                        uuid4().hex,
                        user_id,
                        user["credential_ref"],
                        session["id"],
                        kind,
                        json.dumps(payload),
                        time.time(),
                        time.time(),
                    ),
                )

    def deliver(self):
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            item = connection.execute(
                "SELECT o.* FROM lastfm_outbox o JOIN lastfm_users u ON u.user_id=o.user_id JOIN users account ON account.id=o.user_id AND account.enabled=1 WHERE o.status='queued' AND o.next_attempt<=? ORDER BY o.created_at LIMIT 1",
                (time.time(),),
            ).fetchone()
            if item is None:
                return
            user = connection.execute(
                "SELECT * FROM lastfm_users WHERE user_id=?", (item["user_id"],)
            ).fetchone()
            flag = "scrobble" if item["kind"] == "scrobble" else "now_playing"
            stale = (
                item["credential_ref"] != user["credential_ref"]
                or not user[flag]
                or user["needs_auth"]
                or (flag == "now_playing" and time.time() - item["created_at"] > 30)
            )
            if flag == "now_playing":
                session = connection.execute(
                    "SELECT playback_state FROM listening_sessions WHERE id=?",
                    (item["session_id"],),
                ).fetchone()
                newest = connection.execute(
                    "SELECT id FROM listening_sessions WHERE user_id=? ORDER BY started_at DESC LIMIT 1",
                    (item["user_id"],),
                ).fetchone()
                stale = (
                    stale
                    or session is None
                    or session[0] != "playing"
                    or (newest is not None and newest[0] != item["session_id"])
                )
            connection.execute(
                "UPDATE lastfm_outbox SET status=? WHERE id=?",
                ("cancelled" if stale else "sending", item["id"]),
            )
        if stale:
            return
        payload = json.loads(item["payload"])
        if flag == "now_playing":
            payload.pop("timestamp", None)
        try:
            sk = self.secrets().get(item["credential_ref"])
            if not sk:
                raise ProviderError("lastfm_reauthorize", False)
            result = self.request(
                FM,
                payload
                | {
                    "method": "track.scrobble" if flag == "scrobble" else "track.updateNowPlaying",
                    "sk": sk,
                },
                signed=True,
            )
            report = (
                result.get("scrobbles", {}).get("scrobble", {})
                if flag == "scrobble"
                else result.get("nowplaying", {})
            )
            if isinstance(report, list):
                report = report[0] if len(report) == 1 else {}
            ignored = report.get("ignoredMessage")
            if not isinstance(ignored, dict):
                raise ProviderError("lastfm_invalid_response")
            if str(ignored.get("code")) != "0":
                raise ProviderError("lastfm_ignored", False)
            status, error = "sent", None
        except (ProviderError, AttributeError, TypeError, KeyError, ValueError) as failure:
            if not isinstance(failure, ProviderError):
                failure = ProviderError("lastfm_invalid_response")
            error = failure.code
            status = (
                "queued"
                if failure.transient and flag == "scrobble" and item["attempts"] < 8
                else "failed"
            )
            if error == "lastfm_reauthorize":
                with self.database.connect(write=True) as connection:
                    connection.execute(
                        "UPDATE lastfm_users SET needs_auth=1 WHERE user_id=? AND credential_ref=?",
                        (item["user_id"], item["credential_ref"]),
                    )
        with self.database.connect(write=True) as connection:
            connection.execute(
                "UPDATE lastfm_outbox SET status=?,error=?,attempts=attempts+1,next_attempt=?,updated_at=? WHERE id=? AND status='sending'",
                (
                    status,
                    error,
                    time.time() + min(3600, 15 * 2 ** item["attempts"]),
                    time.time(),
                    item["id"],
                ),
            )

    def user_status(self, user_id):
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT username,scrobble,now_playing,needs_auth,version FROM lastfm_users WHERE user_id=?",
                (user_id,),
            ).fetchone()
            counts = {
                r[0]: r[1]
                for r in connection.execute(
                    "SELECT status,count(*) FROM lastfm_outbox WHERE user_id=? GROUP BY status",
                    (user_id,),
                )
            }
        if row is not None:
            row = dict(row)
            for flag in ("scrobble", "now_playing", "needs_auth"):
                row[flag] = bool(row[flag])
        return {
            "configured": self.settings()["lastfm_configured"],
            "connected": row is not None,
            **(dict(row) if row else {"scrobble": False, "now_playing": False, "version": 0}),
            "queue": counts,
        }

    def router(self, auth):
        router = APIRouter(prefix="/api/v1")
        admin = Annotated[dict, Depends(auth.require_admin)]
        member = Annotated[dict, Depends(auth.require_session)]
        mutation = [Depends(auth.require_client)]

        @router.get("/manage/providers")
        def read_settings(user: admin):
            return self.settings()

        @router.post("/manage/providers/network-test", dependencies=mutation)
        def network_test(user: admin, body: object = Body(...)):
            try:
                draft = NetworkTest.model_validate(body)
                if draft.proxy_url is not None:
                    validate_proxy(draft.proxy_url)
            except (ValueError, ValidationError):
                raise HTTPException(422, "invalid_proxy_settings") from None
            if not self.network_test_lock.acquire(blocking=False):
                raise HTTPException(409, "network_test_running")
            try:
                credentials = self.secrets()
                proxy = draft.proxy_url or credentials.get("proxy_url")
                try:
                    result = test_network(draft.proxy_mode, proxy, credentials, self)
                except ValueError as error:
                    raise HTTPException(422, str(error)) from None
                return Response(
                    content=json.dumps(result),
                    media_type="application/json",
                    headers={"Cache-Control": "no-store"},
                )
            finally:
                self.network_test_lock.release()

        @router.put("/manage/providers", dependencies=mutation)
        def save_settings(body: dict, user: admin):
            try:
                body = ProviderSettings.model_validate(body)
            except ValidationError:
                raise HTTPException(422, "invalid_provider_settings") from None
            credentials = {}
            for key in ("api_key", "api_secret"):
                value = getattr(body, key)
                if value is not None:
                    if value and not re.fullmatch("[a-fA-F0-9]{32}", value):
                        raise HTTPException(422, "invalid_provider_credentials")
                    credentials[key] = value
            if body.acoustid_api_key is not None:
                if body.acoustid_api_key and not re.fullmatch(
                    r"[A-Za-z0-9_-]{8,128}", body.acoustid_api_key
                ):
                    raise HTTPException(422, "invalid_acoustid_credentials")
                credentials["acoustid_api_key"] = body.acoustid_api_key
            if body.acoustid:
                if not body.musicbrainz:
                    raise HTTPException(422, "acoustid_requires_musicbrainz")
                if not credentials.get("acoustid_api_key", self.secrets().get("acoustid_api_key")):
                    raise HTTPException(422, "acoustid_not_configured")
                if not shutil.which("fpcalc"):
                    raise HTTPException(422, "fingerprint_tool_missing")
            if body.proxy_url is not None:
                try:
                    validate_proxy(body.proxy_url)
                except ValueError:
                    raise HTTPException(422, "invalid_proxy_url") from None
                credentials["proxy_url"] = body.proxy_url
            if body.proxy_mode == "custom" and not (
                credentials.get("proxy_url") or self.secrets().get("proxy_url")
            ):
                raise HTTPException(422, "proxy_not_configured")
            try:
                parsed = urlsplit(body.public_url)
            except ValueError:
                raise HTTPException(422, "invalid_public_url") from None
            if body.public_url and (
                parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or parsed.query
                or parsed.fragment
                or parsed.path not in {"", "/"}
            ):
                raise HTTPException(422, "invalid_public_url")
            with FileLock(str(self.directory / "settings.lock")):
                with self.database.connect(write=True) as connection:
                    connection.execute("BEGIN IMMEDIATE")
                    previous = connection.execute(
                        "SELECT * FROM provider_settings WHERE id=1"
                    ).fetchone()
                    if previous["version"] != body.version:
                        raise HTTPException(409, "settings_version_conflict")
                    if not previous["enabled"] and body.enabled:
                        connection.execute(
                            "INSERT OR IGNORE INTO provider_seen SELECT id FROM tracks"
                        )
                    connection.execute(
                        "UPDATE provider_settings SET enabled=?,auto_new=?,musicbrainz=?,lastfm=?,caa=?,public_url=?,proxy_mode=?,acoustid=?,priority=?,version=version+1 WHERE id=1",
                        (
                            body.enabled,
                            body.auto_new,
                            body.musicbrainz,
                            body.lastfm,
                            body.caa,
                            body.public_url.rstrip("/"),
                            body.proxy_mode,
                            body.acoustid,
                            json.dumps(body.priority),
                        ),
                    )
                    if credentials:
                        self.secrets(credentials)
            return self.settings()

        @router.post("/manage/providers/query", dependencies=mutation)
        def query(body: BatchQuery, user: admin):
            return self.enqueue(body.track_ids)

        @router.post("/manage/providers/refresh", dependencies=mutation)
        def refresh(body: RefreshQuery, user: admin):
            if (body.scope == "library") != (body.id is None):
                raise HTTPException(422, "invalid_refresh_scope")
            return self.enqueue(
                scope=body.scope,
                identity=body.id,
                mode=body.mode,
                force=body.force,
                track_batch=True,
            )

        @router.get("/manage/providers/refresh/{batch_id}")
        def refresh_progress(batch_id: str, user: admin, response: Response):
            from wildstring.provider_batches import batch_progress

            response.headers["Cache-Control"] = "private, no-store"
            response.headers["Vary"] = "Cookie"
            return batch_progress(self.repository, batch_id)

        @router.get("/manage/providers/tasks")
        def tasks(
            user: admin,
            response: Response,
            view: View = "active",
            limit: int = Query(20, ge=1, le=50),
            offset: int = Query(0, ge=0),
            batch_id: str | None = Query(None, max_length=128),
        ):
            response.headers["Cache-Control"] = "private, no-store"
            response.headers["Vary"] = "Cookie"
            return task_page(self.repository, view, limit, offset, batch_id)

        @router.post("/manage/providers/tasks/history/clear", dependencies=mutation)
        def clear_tasks(body: HistoryClear, user: admin):
            return clear_history(self.repository, body.through)

        @router.post("/manage/providers/tasks/tracks/{track_id}/review", dependencies=mutation)
        def review_track_tasks(track_id: str, body: ReviewTasks, user: admin):
            return review_tasks(self.repository, track_id, body)

        @router.post("/manage/providers/tasks/{job_id}/retry", dependencies=mutation)
        def retry_provider_task(job_id: str, user: admin):
            return retry_task(self, job_id)

        @router.get("/manage/providers/jobs")
        def provider_jobs(user: admin):
            with self.database.connect() as connection:
                items = [
                    dict(row)
                    for row in connection.execute(
                        "SELECT j.*,t.title FROM provider_jobs j JOIN tracks t ON t.id=j.track_id WHERE t.library_id=? ORDER BY j.created_at DESC LIMIT 20",
                        (self.repository.library_id(),),
                    )
                ]
                counts = dict(
                    connection.execute(
                        "SELECT j.status,count(*) FROM provider_jobs j JOIN tracks t ON t.id=j.track_id WHERE t.library_id=? AND j.status IN ('queued','running') GROUP BY j.status",
                        (self.repository.library_id(),),
                    ).fetchall()
                )
            return {
                "items": items,
                "queued": counts.get("queued", 0),
                "running": counts.get("running", 0),
            }

        @router.get("/manage/providers/tracks/{track_id}")
        def results(track_id: str, user: admin):
            MetadataEditor(self.repository).read(track_id)
            with self.database.connect() as connection:
                suggestions = [
                    dict(r)
                    for r in connection.execute(
                        "SELECT * FROM metadata_suggestions WHERE track_id=? ORDER BY created_at DESC LIMIT 30",
                        (track_id,),
                    )
                ]
                jobs = [
                    dict(r)
                    for r in connection.execute(
                        "SELECT * FROM provider_jobs WHERE track_id=? ORDER BY created_at DESC LIMIT 10",
                        (track_id,),
                    )
                ]
            for result in suggestions:
                result["fields"] = json.loads(result["fields"])
                result["match"] = json.loads(result["match"])
            priority = self.source_priority()
            suggestions.sort(
                key=lambda item: (
                    priority.index(item["provider"])
                    if item["provider"] in priority
                    else len(priority),
                    -item["match"].get("score", 0),
                )
            )
            return {
                "suggestions": suggestions,
                "jobs": jobs,
                "provider_names": {value["id"]: value["name"] for value in self.sources.catalog()}
                | {"musicbrainz": "MusicBrainz", "lastfm": "Last.fm"},
            }

        @router.post("/manage/providers/suggestions/{identity}/apply", dependencies=mutation)
        def apply(identity: str, body: ApplySuggestion, user: admin):
            with self.database.connect() as connection:
                row = connection.execute(
                    "SELECT * FROM metadata_suggestions WHERE id=? AND status='pending'",
                    (identity,),
                ).fetchone()
            if row is None:
                raise HTTPException(404, "suggestion_not_found")
            record = MetadataEditor(self.repository).read(row["track_id"])
            if record["version"] != body.version or row["metadata_version"] != body.version:
                raise HTTPException(409, "metadata_version_conflict")
            candidate = json.loads(row["fields"])
            if not body.fields or set(body.fields) - set(candidate):
                raise HTTPException(422, "invalid_suggestion_fields")
            with self.database.connect() as connection:
                track = connection.execute(
                    "SELECT album_id,library_id FROM tracks WHERE id=?", (row["track_id"],)
                ).fetchone()
                from wildstring.album_release_locks import candidate_conflict

                conflict = candidate_conflict(
                    connection, track["library_id"], track["album_id"], row, set(body.fields)
                )
            if conflict:
                raise HTTPException(409, conflict["code"])
            values = record["overrides"] | {key: candidate[key] for key in body.fields}
            saved = MetadataEditor(self.repository).save(
                row["track_id"],
                MetadataUpdate(version=body.version, overrides=Overrides.model_validate(values)),
                user_id=user["id"],
                source=row["provider"] + ":" + row["source_url"],
            )
            with self.database.connect(write=True) as connection:
                connection.execute(
                    "UPDATE metadata_suggestions SET status='applied' WHERE id=?", (identity,)
                )
            return saved

        @router.get("/manage/providers/suggestions/{identity}/cover-preview")
        def cover_preview(identity: str, user: admin):
            with self.database.connect() as connection:
                row = connection.execute(
                    "SELECT s.cover_url FROM metadata_suggestions s JOIN tracks t ON t.id=s.track_id "
                    "WHERE s.id=? AND t.library_id=?",
                    (identity, self.repository.library_id()),
                ).fetchone()
            if row is None or not row["cover_url"]:
                raise HTTPException(404, "suggestion_not_found")
            _, thumbnail = self.cover_data(row["cover_url"])
            return Response(
                thumbnail,
                media_type="image/jpeg",
                headers={
                    "Cache-Control": "private, no-store",
                    "Vary": "Cookie",
                    "X-Content-Type-Options": "nosniff",
                },
            )

        @router.post("/manage/providers/suggestions/{identity}/cover", dependencies=mutation)
        def apply_cover(identity: str, body: CoverApply, user: admin):
            from wildstring.library.artwork import CoverSelection, CoverSelections

            selections = CoverSelections(self)
            payload, _ = selections.prepare(
                CoverSelection(suggestion_id=identity, metadata_version=body.version)
            )
            with self.database.connect(write=True) as connection:
                connection.execute("BEGIN IMMEDIATE")
                selections.save_in_transaction(connection, CoverSelection.model_validate(payload))
            return {"applied": True}

        @router.get("/lastfm")
        def status(user: member):
            return self.user_status(user["id"])

        @router.post("/lastfm/authorize", dependencies=mutation)
        def authorize(user: member, response: Response):
            response.headers["Cache-Control"] = "no-store"
            config, credentials = self.settings(), self.secrets()
            if not config["enabled"] or not config["lastfm_configured"] or not config["public_url"]:
                raise HTTPException(409, "lastfm_not_configured")
            state = secrets.token_urlsafe(32)
            clock = time.time()
            with self.database.connect(write=True) as connection:
                connection.execute(
                    "DELETE FROM lastfm_auth WHERE user_id=? OR expires_at<?", (user["id"], clock)
                )
                connection.execute(
                    "INSERT INTO lastfm_auth VALUES (?,?,?,?)",
                    (hashlib.sha256(state.encode()).hexdigest(), user["id"], clock + 600, clock),
                )
            callback = config["public_url"] + "/api/v1/lastfm/callback?state=" + state
            return {
                "url": "https://www.last.fm/api/auth/?"
                + urlencode({"api_key": credentials["api_key"], "cb": callback})
            }

        @router.get("/lastfm/callback", response_class=HTMLResponse)
        def callback(state: str = Query(max_length=128), token: str = Query(max_length=128)):
            digest = hashlib.sha256(state.encode()).hexdigest()
            claimed = "claimed:" + digest
            with self.database.connect(write=True) as connection:
                connection.execute("BEGIN IMMEDIATE")
                row = connection.execute(
                    "SELECT a.user_id FROM lastfm_auth a JOIN users u ON u.id=a.user_id WHERE state_hash=? AND expires_at>? AND u.enabled=1",
                    (digest, time.time()),
                ).fetchone()
                if row is not None:
                    connection.execute(
                        "UPDATE lastfm_auth SET state_hash=? WHERE state_hash=?", (claimed, digest)
                    )
            if row is None:
                raise HTTPException(400, "lastfm_auth_expired")
            reference, previous = None, None
            try:
                result = self.request(
                    FM, {"method": "auth.getSession", "token": token}, signed=True
                )["session"]
                if (
                    not isinstance(result, dict)
                    or not isinstance(result.get("key"), str)
                    # Session keys are opaque credentials, not MD5 method signatures.
                    or not 1 <= len(result["key"]) <= 256
                    or not result["key"].isprintable()
                    or any(char.isspace() for char in result["key"])
                    or not isinstance(result.get("name"), str)
                    or not 1 <= len(result["name"]) <= 200
                ):
                    raise ProviderError("lastfm_invalid_session", False)
                reference = uuid4().hex
                with self.database.connect(write=True) as connection:
                    connection.execute("BEGIN IMMEDIATE")
                    active = connection.execute(
                        "SELECT 1 FROM lastfm_auth a JOIN users u ON u.id=a.user_id WHERE state_hash=? AND a.user_id=? AND u.enabled=1 AND expires_at>?",
                        (claimed, row[0], time.time()),
                    ).fetchone()
                    if active is None:
                        raise HTTPException(409, "lastfm_auth_cancelled")
                    previous = connection.execute(
                        "SELECT credential_ref FROM lastfm_users WHERE user_id=?", (row[0],)
                    ).fetchone()
                    self.secrets({reference: result["key"]})
                    connection.execute(
                        "INSERT INTO lastfm_users(user_id,username,credential_ref,enabled_since) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username,credential_ref=excluded.credential_ref,scrobble=0,now_playing=0,needs_auth=0,version=lastfm_users.version+1,enabled_since=excluded.enabled_since",
                        (row[0], result["name"], reference, time.time()),
                    )
                    connection.execute("DELETE FROM lastfm_auth WHERE state_hash=?", (claimed,))
                    connection.execute(
                        "UPDATE lastfm_outbox SET status='cancelled' WHERE user_id=? AND status IN ('queued','sending')",
                        (row[0],),
                    )
                if previous:
                    self.secrets({previous[0]: None})
            except (ProviderError, KeyError, TypeError, AttributeError) as error:
                code = error.code if isinstance(error, ProviderError) else "lastfm_invalid_session"
                logger.warning("Last.fm authorization failed: %s", code)
                raise HTTPException(502, "lastfm_auth_failed") from None
            finally:
                with self.database.connect(write=True) as connection:
                    connection.execute("DELETE FROM lastfm_auth WHERE state_hash=?", (claimed,))
                    bound = (
                        connection.execute(
                            "SELECT 1 FROM lastfm_users WHERE credential_ref=?", (reference,)
                        ).fetchone()
                        if reference
                        else None
                    )
                if reference and not bound:
                    self.secrets({reference: None})
            return HTMLResponse(
                '<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Last.fm 已连接</title><p>已连接 Last.fm。请关闭此页，返回野弦刷新，再选择是否同步收听。</p></html>',
                headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
            )

        @router.put("/lastfm", dependencies=mutation)
        def preferences(body: LastfmPreferences, user: member):
            with self.database.connect(write=True) as connection:
                connection.execute("BEGIN IMMEDIATE")
                row = connection.execute(
                    "SELECT * FROM lastfm_users WHERE user_id=?", (user["id"],)
                ).fetchone()
                if row is None or row["version"] != body.version:
                    raise HTTPException(409, "settings_version_conflict")
                enabled_since = (
                    time.time() if not row["scrobble"] and body.scrobble else row["enabled_since"]
                )
                connection.execute(
                    "UPDATE lastfm_users SET scrobble=?,now_playing=?,enabled_since=?,version=version+1 WHERE user_id=?",
                    (body.scrobble, body.now_playing, enabled_since, user["id"]),
                )
                for kind, enabled in (
                    ("scrobble", body.scrobble),
                    ("now_playing", body.now_playing),
                ):
                    if not enabled:
                        connection.execute(
                            "UPDATE lastfm_outbox SET status='cancelled' WHERE user_id=? AND kind=? AND status IN ('queued','sending')",
                            (user["id"], kind),
                        )
            return self.user_status(user["id"])

        @router.delete("/lastfm", dependencies=mutation)
        def disconnect(user: member):
            with self.database.connect(write=True) as connection:
                reference = connection.execute(
                    "SELECT credential_ref FROM lastfm_users WHERE user_id=?", (user["id"],)
                ).fetchone()
                connection.execute("DELETE FROM lastfm_users WHERE user_id=?", (user["id"],))
                connection.execute("DELETE FROM lastfm_auth WHERE user_id=?", (user["id"],))
                connection.execute(
                    "UPDATE lastfm_outbox SET status='cancelled' WHERE user_id=? AND status IN ('queued','sending')",
                    (user["id"],),
                )
            if reference:
                self.secrets({reference[0]: None})
            return {"connected": False}

        return router


class ProviderSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: int = Field(ge=1)
    enabled: bool
    auto_new: bool = True
    musicbrainz: bool = True
    lastfm: bool = True
    caa: bool = True
    acoustid: bool = False
    priority: list[Literal["musicbrainz", "lastfm"]] = Field(
        default_factory=lambda: ["musicbrainz", "lastfm"], min_length=2, max_length=2
    )
    public_url: str = Field(default="", max_length=2048)
    proxy_mode: Literal["environment", "custom", "direct"] = "environment"
    proxy_url: str | None = Field(default=None, max_length=2048, repr=False)
    api_key: str | None = Field(default=None, max_length=128, repr=False)
    api_secret: str | None = Field(default=None, max_length=128, repr=False)
    acoustid_api_key: str | None = Field(default=None, max_length=128, repr=False)

    @field_validator("priority")
    @classmethod
    def unique_priority(cls, value):
        if len(set(value)) != 2:
            raise ValueError("Duplicate metadata source")
        return value


class BatchQuery(BaseModel):
    track_ids: list[str] = Field(min_length=1, max_length=100)


class RefreshQuery(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    scope: Literal["track", "album", "library"]
    id: str | None = Field(default=None, min_length=1, max_length=128)
    mode: Literal["missing", "all"] = "missing"
    force: bool = False


class ApplySuggestion(BaseModel):
    version: int = Field(ge=1, strict=True)
    fields: list[str] = Field(min_length=1, max_length=30)


class LastfmPreferences(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: int = Field(ge=1)
    scrobble: bool
    now_playing: bool


class CoverApply(BaseModel):
    version: int = Field(ge=1, strict=True)
