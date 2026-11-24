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
    except podcast_module.PodcastURLRejected:
        raise UpstreamFailure("network_unavailable") from None
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
            "title": item.get("collectionName"),
            "authors": [item.get("artistName")],
            "description": item.get("description"),
            "published_year": int(release)
            if len(release) == 4 and release.isascii() and release.isdigit()
            else None,
        }
        identity = item.get("collectionId")
    if not clean_text(fields.get("title")) or not fields["title"].strip():
        return None
    clean = {key: value for key, value in fields.items() if clean_text(value) or type(value) is int}
    if isinstance(fields.get("authors"), list):
        clean["authors"] = [name for name in fields["authors"][:64] if clean_text(name)]
    return {"provider": provider, "external_id": str(identity or ""), "fields": clean}


class BookProviders:
    def __init__(self, *, network_policy=None, itunes_gate=None, allow_fake_ip: bool = False):
        self.network_policy = network_policy
        self.allow_fake_ip = allow_fake_ip
        self.gates = {
            provider: SearchGate(upstream_per_minute=15, user_per_minute=8)
            for provider in PROVIDERS
        }
        self.itunes_gate = itunes_gate

    def search(self, provider: Provider, query: str, user_id: str):
        gate = self.gates[provider]
        upstream_gate = self.itunes_gate if provider == "itunes" and self.itunes_gate else gate
        try:
            gate.admit_user(user_id)
            upstream_gate.reserve_upstream(1)
        except SearchRateLimited as error:
            raise HTTPException(
                429, "book_metadata_rate_limited", {"Retry-After": str(error.retry_after)}
            ) from error
        proxy_mode, proxy_url = (
            self.network_policy() if self.network_policy is not None else ("environment", None)
        )
        endpoint, key, fields = PROVIDERS[provider]
        url = f"{endpoint}?{urlencode(fields | {key: query})}"
        try:
            result = fetch_catalog_json(
                url, proxy_mode, proxy_url, allow_fake_ip=self.allow_fake_ip
            )
        except UpstreamFailure as error:
            if error.retry_after:
                upstream_gate.cool_down(error.retry_after)
            raise HTTPException(502, "book_metadata_upstream_failed") from error
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
        return [entry for row in rows[:15] if (entry := catalog_entry(provider, row)) is not None]
