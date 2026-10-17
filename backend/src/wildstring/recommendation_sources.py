"""Bounded official Last.fm adapters; public metadata, never download resources."""

import hashlib
import json
import time
from urllib.parse import urlsplit, urlunsplit

from fastapi import HTTPException
from filelock import FileLock, Timeout

from wildstring.library.metadata import normalize
from wildstring.providers import FM, ProviderError

LOCAL_SOURCES = ("personal", "community", "discovery", "revisit")
EXTERNAL_SOURCES = ("lastfm_similar", "lastfm_charts", "lastfm_tags", "lastfm_artists")
SOURCE_LABELS = {
    "lastfm_similar": "Last.fm 歌曲相似关系",
    "lastfm_charts": "Last.fm 公共热门榜",
    "lastfm_tags": "Last.fm 标签热门歌曲",
    "lastfm_artists": "Last.fm 艺人关联与热门歌曲",
}


class SourceUnavailable(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def source_url(value):
    if not isinstance(value, str) or len(value) > 2048:
        return None
    try:
        parts = urlsplit(value)
        if (
            parts.scheme not in {"https", "http"}
            or parts.hostname not in {"www.last.fm", "last.fm"}
            or parts.port not in {None, 80, 443}
            or parts.username
            or parts.password
            or any(ord(c) < 32 for c in value)
        ):
            return None
        return urlunsplit(("https", "www.last.fm", parts.path, "", ""))
    except ValueError:
        return None


def track_item(item, source):
    if not isinstance(item, dict):
        return None
    name = item.get("name")
    artist = item.get("artist")
    artist = artist.get("name") if isinstance(artist, dict) else artist
    if (
        not isinstance(name, str)
        or not name.strip()
        or not isinstance(artist, str)
        or not artist.strip()
    ):
        return None
    name, artist = name.strip()[:300], artist.strip()[:200]
    identity = hashlib.sha256((normalize(artist) + "\n" + normalize(name)).encode()).hexdigest()
    album = item.get("album")
    if isinstance(album, dict):
        album = album.get("title") or album.get("name")
    album = album[:300] if isinstance(album, str) and album.strip() else None
    return {
        "external_id": "lastfm:" + identity,
        "name": name,
        "artists": [artist],
        "album": album,
        "source_url": source_url(item.get("url")),
        "source": source,
        "evidence": [
            {"source": source, "summary": SOURCE_LABELS[source], "url": source_url(item.get("url"))}
        ],
    }


class LastfmSources:
    def __init__(self, providers):
        self.providers = providers
        self.database = providers.database
        self.calls = 0
        self.max_calls = 6
        self.warnings = []
        self.deadline = time.monotonic() + 25

    def request(self, source, parameters, root):
        config = self.providers.settings()
        if not config["enabled"] or not config["lastfm"] or not config["lastfm_configured"]:
            raise SourceUnavailable("lastfm_not_configured")
        key = hashlib.sha256(
            json.dumps(
                {"parameters": parameters, "configuration_version": config.get("version", 0)},
                sort_keys=True,
                ensure_ascii=False,
            ).encode()
        ).hexdigest()
        directory = self.database.path.parent / "recommendations"
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            with FileLock(str(directory / ("source-" + key + ".lock")), timeout=1):
                with self.database.connect() as connection:
                    row = connection.execute(
                        "SELECT payload FROM recommendation_source_cache WHERE source=? AND cache_key=? AND expires_at>?",
                        (source, key, time.time()),
                    ).fetchone()
                if row:
                    result = json.loads(row["payload"])
                    if "error_code" in result:
                        raise SourceUnavailable(result["error_code"])
                    return result["items"], True
                if self.calls >= self.max_calls or time.monotonic() >= self.deadline:
                    raise SourceUnavailable("source_call_budget_exhausted")
                self.calls += 1
                try:
                    payload = self.providers.request(
                        FM, parameters, timeout_limit=min(5, self.deadline - time.monotonic())
                    )
                    section = payload.get(root)
                    if root == "tracks" and section is None:
                        section = payload.get("toptracks")
                    kind = "artist" if root == "similarartists" else "track"
                    rows = section.get(kind) if isinstance(section, dict) else None
                    if isinstance(rows, dict):
                        rows = [rows]
                    if not isinstance(rows, list):
                        raise SourceUnavailable("lastfm_invalid_response")
                    items = (
                        [
                            value["name"][:200]
                            for value in rows[:5]
                            if isinstance(value, dict)
                            and isinstance(value.get("name"), str)
                            and value["name"].strip()
                        ]
                        if kind == "artist"
                        else [
                            entry
                            for value in rows[:50]
                            if (entry := track_item(value, source)) is not None
                        ]
                    )
                    result = {"items": items}
                    ttl = 21600 if source == "lastfm_charts" else 86400
                except (
                    SourceUnavailable,
                    ProviderError,
                    HTTPException,
                    OSError,
                    ValueError,
                    TypeError,
                    AttributeError,
                ) as failure:
                    result = {"error_code": getattr(failure, "code", "lastfm_unavailable")}
                    ttl = 300
                with self.database.connect(write=True) as connection:
                    connection.execute(
                        "DELETE FROM recommendation_source_cache WHERE expires_at<?", (time.time(),)
                    )
                    if (
                        connection.execute(
                            "SELECT count(*) FROM recommendation_source_cache"
                        ).fetchone()[0]
                        >= 300
                    ):
                        connection.execute(
                            "DELETE FROM recommendation_source_cache WHERE rowid IN (SELECT rowid FROM recommendation_source_cache ORDER BY created_at LIMIT 100)"
                        )
                    connection.execute(
                        "INSERT OR REPLACE INTO recommendation_source_cache VALUES (?,?,?,?,?)",
                        (
                            source,
                            key,
                            json.dumps(result, ensure_ascii=False),
                            time.time(),
                            time.time() + ttl,
                        ),
                    )
                if "error_code" in result:
                    raise SourceUnavailable(result["error_code"])
                return result["items"], False
        except Timeout:
            raise SourceUnavailable("source_refresh_in_progress") from None

    def collect(self, source, *, seeds=(), tags=()):
        results, failures = [], []
        cached = True

        def gather(parameters, root):
            nonlocal cached
            try:
                rows, hit = self.request(source, parameters, root)
                cached = cached and hit
                return rows
            except SourceUnavailable as failure:
                failures.append(failure)
                cached = False
                return []

        if source == "lastfm_charts":
            return self.request(source, {"method": "chart.getTopTracks", "limit": 50}, "tracks")
        if source == "lastfm_tags":
            if not tags:
                raise SourceUnavailable("lastfm_tags_not_selected")
            for tag in list(dict.fromkeys(tags))[:3]:
                results.extend(
                    gather({"method": "tag.getTopTracks", "tag": tag[:50], "limit": 50}, "tracks")
                )
        elif source == "lastfm_similar":
            for track in [track for track in seeds if track.get("artists")][:2]:
                results.extend(
                    gather(
                        {
                            "method": "track.getSimilar",
                            "artist": track["artists"][0][:200],
                            "track": track["title"][:200],
                            "limit": 30,
                            "autocorrect": 0,
                        },
                        "similartracks",
                    )
                )
        elif source == "lastfm_artists":
            artists = list(
                dict.fromkeys(artist for track in seeds for artist in track.get("artists", []))
            )[:2]
            if artists:
                related = gather(
                    {
                        "method": "artist.getSimilar",
                        "artist": artists[0][:200],
                        "limit": 1,
                        "autocorrect": 0,
                    },
                    "similarartists",
                )
                for artist in list(dict.fromkeys([artists[0], *related[:1]])):
                    results.extend(
                        gather(
                            {
                                "method": "artist.getTopTracks",
                                "artist": artist[:200],
                                "limit": 30,
                                "autocorrect": 0,
                            },
                            "toptracks",
                        )
                    )
        else:
            raise SourceUnavailable("unknown_recommendation_source")
        if failures and not results:
            raise failures[0]
        self.warnings.extend({"source": source, "code": failure.code} for failure in failures)
        return list({item["external_id"]: item for item in results}.values())[:100], cached


def local_matches(repository, items):
    """One local title scan; exact credited artist, ambiguous versions stay external."""
    by_title = {}
    for item in items:
        by_title.setdefault(normalize(item["name"]), []).append(
            (item["external_id"], {normalize(name) for name in item["artists"]})
        )
    if not by_title:
        return {}
    candidates = {}
    with repository.database.connect() as connection:
        connection.create_function("recommend_normalized", 1, normalize)
        rows = connection.execute(
            "SELECT id,title,artists FROM tracks WHERE library_id=? AND status='available' AND recommend_normalized(title) IN (SELECT value FROM json_each(?))",
            (repository.library_id(), json.dumps(list(by_title))),
        )
        for row in rows:
            credited = {normalize(name) for name in json.loads(row["artists"])}
            for identity, artists in by_title[normalize(row["title"])]:
                if credited.intersection(artists):
                    choices = candidates.setdefault(identity, [])
                    if len(choices) < 2:
                        choices.append(row["id"])
    matched = {}
    for identity, choices in candidates.items():
        if len(choices) == 1:
            track = repository.track(choices[0])
            if track and track["status"] == "available":
                track.pop("path", None)
                matched[identity] = track
    return matched
