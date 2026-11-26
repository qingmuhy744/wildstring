"""Bounded searches of fixed public book catalogs."""

import json
import urllib.request
from typing import Any, Literal
from urllib.error import HTTPError
from urllib.parse import urlencode

from fastapi import HTTPException

from wildstring import podcasts as podcast_module
from wildstring.library.sidecar import clean_text
from wildstring.outbound import OutboundError, outbound_proxies, request_bytes
from wildstring.podcast_search import (
    MAX_RESPONSE_BYTES,
    THROTTLE_COOLDOWN_SECONDS,
    UPSTREAM_TIMEOUT_SECONDS,
    SearchGate,
    SearchRateLimited,
    UpstreamFailure,
)

Provider = Literal["openlibrary", "google_books", "itunes"]
BUILTIN_SOURCES: tuple[tuple[Provider, str], ...] = (
    ("itunes", "Apple iTunes"),
    ("openlibrary", "Open Library"),
    ("google_books", "Google Books"),
)
PROVIDER_NAMES: dict[str, str] = dict(BUILTIN_SOURCES)
DEFAULT_ENABLED: dict[str, bool] = {
    "itunes": True,
    "openlibrary": True,
    "google_books": False,
}
PROVIDERS = {
    "openlibrary": (
        "https://openlibrary.org/search.json",
        "q",
        {
            "fields": "key,title,author_name,publisher,first_publish_year,language,isbn",
            "limit": 15,
        },
    ),
    "google_books": ("https://www.googleapis.com/books/v1/volumes", "q", {"maxResults": 15}),
    "itunes": ("https://itunes.apple.com/search", "term", {"media": "audiobook", "limit": 15}),
}
ITUNES_QUERIES = (
    {"media": "ebook", "entity": "ebook", "limit": 10},
    {"media": "audiobook", "limit": 10},
)
SETTINGS_TABLE_SQL = """CREATE TABLE IF NOT EXISTS book_metadata_settings (
    id INTEGER PRIMARY KEY CHECK(id=1),
    itunes INTEGER NOT NULL DEFAULT 1 CHECK(itunes IN (0,1)),
    openlibrary INTEGER NOT NULL DEFAULT 1 CHECK(openlibrary IN (0,1)),
    google_books INTEGER NOT NULL DEFAULT 0 CHECK(google_books IN (0,1))
)"""


def fetch_catalog_json(
    url: str,
    proxy_mode: str,
    proxy_url: str | None,
    *,
    allow_fake_ip: bool = False,
) -> dict[str, Any]:
    """Request one fixed public catalog endpoint without redirects or private-network access."""
    try:
        proxies = outbound_proxies(proxy_mode, proxy_url)
    except ValueError as exc:
        raise UpstreamFailure("network_unavailable") from exc
    trusted = podcast_module.proxy_endpoints(proxies)

    def opener(*handlers):
        return urllib.request.build_opener(
            *handlers,
            podcast_module.SafeHTTPHandler(trusted, allow_fake_ip=allow_fake_ip),
            podcast_module.SafeHTTPSHandler(trusted, allow_fake_ip=allow_fake_ip),
        )

    request = urllib.request.Request(
        url,
        headers={"User-Agent": podcast_module.USER_AGENT, "Accept": "application/json"},
    )
    try:
        _status, _headers, body = request_bytes(
            request,
            proxy_mode=proxy_mode,
            proxy_url=proxy_url,
            timeout=UPSTREAM_TIMEOUT_SECONDS,
            limit=MAX_RESPONSE_BYTES,
            opener_factory=opener,
            service="book_metadata",
        )
    except HTTPError as exc:
        if exc.code in {403, 429}:
            retry = exc.headers.get("Retry-After") if exc.headers else None
            try:
                seconds = float(retry) if retry else THROTTLE_COOLDOWN_SECONDS
            except ValueError:
                seconds = THROTTLE_COOLDOWN_SECONDS
            raise UpstreamFailure("upstream_rate_limited", seconds) from None
        raise UpstreamFailure("upstream_http_error") from None
    except OutboundError as exc:
        raise UpstreamFailure("timeout" if exc.code == "timeout" else exc.code) from None
    except podcast_module.PodcastURLRejected as exc:
        raise UpstreamFailure(str(exc) or "network_unavailable") from None
    try:
        payload = json.loads(body)
    except ValueError:
        raise UpstreamFailure("upstream_invalid_response") from None
    if not isinstance(payload, dict):
        raise UpstreamFailure("upstream_invalid_response")
    return payload


def first(items):
    return items[0] if isinstance(items, list) and items else None


def catalog_entry(provider, item):
    if not isinstance(item, dict):
        return None
    if provider == "openlibrary":
        identifiers = item.get("isbn")
        isbns = (
            [value for value in identifiers if isinstance(value, str)]
            if isinstance(identifiers, list)
            else []
        )
        fields = {
            "title": item.get("title"),
            "authors": item.get("author_name"),
            "publisher": first(item.get("publisher")),
            "published_year": item.get("first_publish_year"),
            "language": first(item.get("language")),
            "isbn10": next((value for value in isbns if len(value) == 10), None),
            "isbn13": next((value for value in isbns if len(value) == 13), None),
        }
        identity = item.get("key")
    elif provider == "google_books":
        book = item.get("volumeInfo")
        if not isinstance(book, dict):
            return None
        release = str(book.get("publishedDate", ""))[:4]
        fields = {
            key: book.get(key)
            for key in ("title", "subtitle", "authors", "publisher", "description", "language")
        }
        fields["published_year"] = (
            int(release) if len(release) == 4 and release.isascii() and release.isdigit() else None
        )
        identifiers = book.get("industryIdentifiers")
        if isinstance(identifiers, list):
            for identifier in identifiers:
                if isinstance(identifier, dict):
                    kind = {"ISBN_10": "isbn10", "ISBN_13": "isbn13"}.get(
                        str(identifier.get("type"))
                    )
                    if kind:
                        fields[kind] = identifier.get("identifier")
        identity = item.get("id")
    else:
        release = str(item.get("releaseDate", ""))[:4]
        fields = {
            "title": item.get("trackName") or item.get("collectionName"),
            "authors": [item.get("artistName")],
            "description": item.get("description"),
            "published_year": int(release)
            if len(release) == 4 and release.isascii() and release.isdigit()
            else None,
        }
        identity = item.get("trackId") or item.get("collectionId")
    if not clean_text(fields.get("title")) or not fields["title"].strip():
        return None
    clean = {key: value for key, value in fields.items() if clean_text(value) or type(value) is int}
    if isinstance(fields.get("authors"), list):
        clean["authors"] = [name for name in fields["authors"][:64] if clean_text(name)]
    return {
        "provider": provider,
        "provider_name": PROVIDER_NAMES.get(provider, provider),
        "external_id": str(identity or ""),
        "fields": clean,
    }


def _http_exception_for_failure(error: UpstreamFailure) -> HTTPException:
    if error.code == "remote_url_fake_ip":
        return HTTPException(422, "remote_url_fake_ip")
    if error.code == "upstream_rate_limited":
        seconds = max(1, int(error.retry_after or THROTTLE_COOLDOWN_SECONDS))
        return HTTPException(429, "book_metadata_rate_limited", {"Retry-After": str(seconds)})
    return HTTPException(502, "book_metadata_upstream_failed")


class BookProviders:
    def __init__(
        self,
        *,
        database=None,
        network_policy=None,
        itunes_gate=None,
        allow_fake_ip: bool = False,
    ):
        self.database = database
        self.network_policy = network_policy
        self.allow_fake_ip = allow_fake_ip
        self.gates = {
            provider: SearchGate(upstream_per_minute=15, user_per_minute=8)
            for provider in PROVIDERS
        }
        self.itunes_gate = itunes_gate

    def _ensure_settings(self, db):
        db.execute(SETTINGS_TABLE_SQL)
        db.execute("INSERT OR IGNORE INTO book_metadata_settings(id) VALUES (1)")

    def _format_sources(self, enabled_map: dict[str, bool]) -> dict[str, list[dict[str, Any]]]:
        all_sources = [
            {
                "id": sid,
                "name": name,
                "kind": "builtin",
                "enabled": bool(enabled_map.get(sid, DEFAULT_ENABLED[sid])),
            }
            for sid, name in BUILTIN_SOURCES
        ]
        return {
            "items": [item for item in all_sources if item["enabled"]],
            "all_sources": all_sources,
        }

    def sources_state(self) -> dict[str, list[dict[str, Any]]]:
        if self.database is None:
            return self._format_sources(dict(DEFAULT_ENABLED))
        with self.database.connect(write=True) as db:
            self._ensure_settings(db)
            row = db.execute(
                "SELECT itunes, openlibrary, google_books FROM book_metadata_settings WHERE id=1"
            ).fetchone()
        return self._format_sources({sid: bool(row[sid]) for sid, _ in BUILTIN_SOURCES})

    def update_sources(self, updates: dict[str, bool | None]) -> dict[str, list[dict[str, Any]]]:
        clean = {
            key: int(bool(value))
            for key, value in updates.items()
            if key in DEFAULT_ENABLED and value is not None
        }
        if self.database is None:
            merged = dict(DEFAULT_ENABLED) | {k: bool(v) for k, v in clean.items()}
            return self._format_sources(merged)
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            self._ensure_settings(db)
            if clean:
                assignments = ",".join(f"{key}=?" for key in clean)
                db.execute(
                    f"UPDATE book_metadata_settings SET {assignments} WHERE id=1",  # nosec B608
                    tuple(clean.values()),
                )
            row = db.execute(
                "SELECT itunes, openlibrary, google_books FROM book_metadata_settings WHERE id=1"
            ).fetchone()
        return self._format_sources({sid: bool(row[sid]) for sid, _ in BUILTIN_SOURCES})

    def _request_rows(
        self,
        provider: Provider,
        url: str,
        proxy_mode: str,
        proxy_url: str | None,
        upstream_gate: SearchGate,
    ) -> list[Any]:
        try:
            result = fetch_catalog_json(
                url, proxy_mode, proxy_url, allow_fake_ip=self.allow_fake_ip
            )
        except UpstreamFailure as error:
            if error.retry_after:
                upstream_gate.cool_down(error.retry_after)
            raise _http_exception_for_failure(error) from error
        if provider == "openlibrary":
            rows = result.get("docs")
        elif provider == "google_books":
            rows = (
                []
                if "items" not in result and isinstance(result.get("totalItems"), int)
                else result.get("items")
            )
        else:
            rows = result.get("results")
        if not isinstance(rows, list):
            raise HTTPException(502, "book_metadata_upstream_failed")
        return rows

    def search(self, provider: Provider, query: str, user_id: str):
        gate = self.gates[provider]
        upstream_gate = self.itunes_gate if provider == "itunes" and self.itunes_gate else gate
        queries = (
            [("term", params) for params in ITUNES_QUERIES]
            if provider == "itunes"
            else [(PROVIDERS[provider][1], PROVIDERS[provider][2])]
        )
        try:
            gate.admit_user(user_id)
            upstream_gate.reserve_upstream(len(queries))
        except SearchRateLimited as error:
            raise HTTPException(
                429, "book_metadata_rate_limited", {"Retry-After": str(error.retry_after)}
            ) from error
        proxy_mode, proxy_url = (
            self.network_policy() if self.network_policy is not None else ("environment", None)
        )
        endpoint = PROVIDERS[provider][0]
        trimmed = query.strip()
        effective_query = trimmed or query
        entries: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        first_error: HTTPException | None = None
        succeeded = False
        for key, fields in queries:
            effective_key = "title" if provider == "openlibrary" and len(trimmed) < 3 else key
            url = f"{endpoint}?{urlencode(fields | {effective_key: effective_query})}"
            try:
                rows = self._request_rows(provider, url, proxy_mode, proxy_url, upstream_gate)
                succeeded = True
            except HTTPException as exc:
                if first_error is None:
                    first_error = exc
                continue
            for row in rows[:15]:
                entry = catalog_entry(provider, row)
                if entry is None:
                    continue
                dedupe_key = (entry["external_id"], entry["fields"]["title"])
                if dedupe_key in seen:
                    continue
                seen.add(dedupe_key)
                entries.append(entry)
                if len(entries) >= 15:
                    break
        if not succeeded and first_error is not None:
            raise first_error
        return entries[:15]

    def search_many(self, providers: list[Provider], query: str, user_id: str):
        if len(providers) == 1:
            return self.search(providers[0], query, user_id)
        per_source: list[list[dict[str, Any]]] = []
        first_error: HTTPException | None = None
        succeeded = False
        for provider in providers:
            try:
                per_source.append(self.search(provider, query, user_id))
                succeeded = True
            except HTTPException as exc:
                if first_error is None:
                    first_error = exc
        if not succeeded and first_error is not None:
            raise first_error
        entries: list[dict[str, Any]] = []
        seen: set[tuple[str, str, str]] = set()
        max_len = max((len(group) for group in per_source), default=0)
        for index in range(max_len):
            for group in per_source:
                if index >= len(group):
                    continue
                entry = group[index]
                dedupe_key = (entry["provider"], entry["external_id"], entry["fields"]["title"])
                if dedupe_key in seen:
                    continue
                seen.add(dedupe_key)
                entries.append(entry)
                if len(entries) >= 20:
                    return entries
        return entries
