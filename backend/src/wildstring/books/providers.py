"""Bounded searches of fixed public book catalogs."""

from typing import Literal
from urllib.parse import urlencode

from fastapi import HTTPException

from wildstring.library.sidecar import clean_text
from wildstring.podcast_search import (
    SearchGate,
    SearchRateLimited,
    UpstreamFailure,
    fetch_itunes_json,
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
    def __init__(self):
        self.gates = {
            provider: SearchGate(upstream_per_minute=15, user_per_minute=8)
            for provider in PROVIDERS
        }

    def search(self, provider, query, user_id):
        gate = self.gates[provider]
        try:
            gate.admit_user(user_id)
            gate.reserve_upstream(1)
        except SearchRateLimited as error:
            raise HTTPException(
                429, "book_metadata_rate_limited", {"Retry-After": str(error.retry_after)}
            ) from error
        endpoint, key, fields = PROVIDERS[provider]
        url = f"{endpoint}?{urlencode(fields | {key: query})}"
        try:
            result = fetch_itunes_json(url, "direct", None)
        except UpstreamFailure as error:
            if error.retry_after:
                gate.cool_down(error.retry_after)
            raise HTTPException(502, "book_metadata_upstream_failed") from error
        key = {"openlibrary": "docs", "google_books": "items", "itunes": "results"}[provider]
        rows = result.get(key, [])
        if not isinstance(rows, list):
            raise HTTPException(502, "book_metadata_upstream_failed")
        return [entry for row in rows[:15] if (entry := catalog_entry(provider, row)) is not None]
