"""Search the public iTunes podcast directory and preview feeds before adding them.

Apple documents a limit of roughly 20 calls per minute for the Search API. One
search fans out to several storefronts, so every uncached storefront request is
counted against one shared, process-wide budget. Results are cached briefly and
never persisted; only a feed the user explicitly adds becomes catalog data.
"""

import json
import logging
import math
import threading
import time
import urllib.request
from collections import OrderedDict, deque
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from email.utils import parsedate_to_datetime
from typing import Annotated, Any
from urllib.error import HTTPError
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator

from wildstring import podcasts as podcast_module
from wildstring.outbound import OutboundError, outbound_proxies, request_bytes
from wildstring.podcast_access import catalog_manager, personal_ids
from wildstring.podcast_follows import followed_ids
from wildstring.podcast_identity import feed_keys, normalize_feed_url, valid_itunes_id

logger = logging.getLogger(__name__)

ITUNES_SEARCH_URL = "https://itunes.apple.com/search"
ITUNES_LOOKUP_URL = "https://itunes.apple.com/lookup"
DEFAULT_REGIONS = ("us", "tw", "cn")
# Apple storefront codes accepted for podcast search. Unknown codes are rejected
# instead of silently falling back to the US store.
SUPPORTED_REGIONS = frozenset(
    "ae ar at au be bg br ca ch cl cn co cz de dk ee eg es fi fr gb gr hk hr hu id ie il in "
    "it jp kr kz lt lu lv mo mx my nl no nz pe ph pl pt ro ru sa se sg sk th tr tw ua us vn "
    "za".split()
)
MAX_REGIONS = 5
RESULT_TTL_SECONDS = 600
PREVIEW_TTL_SECONDS = 300
UPSTREAM_CALLS_PER_MINUTE = 18
USER_SEARCHES_PER_MINUTE = 30
USER_PREVIEWS_PER_MINUTE = 12
THROTTLE_COOLDOWN_SECONDS = 60
UPSTREAM_TIMEOUT_SECONDS = 10
MAX_RESPONSE_BYTES = 1024 * 1024
PREVIEW_EPISODES = 5


def parse_regions(value: str | Iterable[str] | None) -> tuple[str, ...]:
    """Return unique, supported storefront codes in their configured order."""
    items = value.split(",") if isinstance(value, str) else list(value or ())
    regions: list[str] = []
    for item in items:
        code = str(item).strip().lower()
        if not code:
            continue
        if code not in SUPPORTED_REGIONS:
            raise ValueError("podcast_search_region_invalid")
        if code not in regions:
            regions.append(code)
    if not regions or len(regions) > MAX_REGIONS:
        raise ValueError("podcast_search_region_invalid")
    return tuple(regions)


class SearchRateLimited(Exception):
    def __init__(self, retry_after: float, *, upstream: bool):
        self.retry_after = max(1, math.ceil(retry_after))
        self.upstream = upstream
        super().__init__("podcast_search_rate_limited")


class UpstreamFailure(Exception):
    def __init__(self, code: str, retry_after: float | None = None):
        self.code, self.retry_after = code, retry_after
        super().__init__(code)


class SearchGate:
    """Process-wide sliding windows for Apple's budget and for each account."""

    def __init__(
        self,
        upstream_per_minute: int | None = None,
        user_per_minute: int | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.upstream_per_minute = upstream_per_minute or UPSTREAM_CALLS_PER_MINUTE
        self.user_per_minute = user_per_minute or USER_SEARCHES_PER_MINUTE
        self.clock = clock
        self.lock = threading.Lock()
        self.upstream: deque[float] = deque()
        self.users: dict[str, deque[float]] = {}
        self.cooldown_until = 0.0

    def _prune(self, window: deque[float], now: float):
        while window and window[0] <= now - 60:
            window.popleft()

    def admit_user(self, key: str, limit: int | None = None):
        limit = limit or self.user_per_minute
        with self.lock:
            now = self.clock()
            window = self.users.setdefault(key, deque())
            self._prune(window, now)
            if len(window) >= limit:
                raise SearchRateLimited(window[0] + 60 - now, upstream=False)
            window.append(now)
            if len(self.users) > 4096:
                for stale in [k for k, v in self.users.items() if not v or v[-1] <= now - 60]:
                    self.users.pop(stale, None)

    def reserve_upstream(self, calls: int):
        if calls <= 0:
            return
        with self.lock:
            now = self.clock()
            if self.cooldown_until > now:
                raise SearchRateLimited(self.cooldown_until - now, upstream=True)
            self._prune(self.upstream, now)
            overflow = len(self.upstream) + calls - self.upstream_per_minute
            if overflow > 0:
                if calls > self.upstream_per_minute:
                    raise SearchRateLimited(60, upstream=True)
                raise SearchRateLimited(self.upstream[overflow - 1] + 60 - now, upstream=True)
            self.upstream.extend([now] * calls)

    def cool_down(self, seconds: float):
        with self.lock:
            self.cooldown_until = max(self.cooldown_until, self.clock() + seconds)


def fetch_itunes_json(url: str, proxy_mode: str, proxy_url: str | None) -> dict[str, Any]:
    """Request one fixed Apple endpoint without redirects or private-network access."""
    try:
        proxies = outbound_proxies(proxy_mode, proxy_url)
    except ValueError as exc:
        raise UpstreamFailure("network_unavailable") from exc
    trusted = podcast_module.proxy_endpoints(proxies)

    def opener(*handlers):
        return urllib.request.build_opener(
            *handlers,
            podcast_module.SafeHTTPHandler(trusted),
            podcast_module.SafeHTTPSHandler(trusted),
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
            service="podcast_search",
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
    if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
        raise UpstreamFailure("upstream_invalid_response")
    return payload


def _text(value: Any, limit: int) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _public_url(value: Any) -> str:
    if not isinstance(value, str) or not value:
        return ""
    try:
        return podcast_module.validate_remote_url(value)[:2048]
    except podcast_module.PodcastURLRejected:
        return ""


def clean_result(raw: Any) -> dict[str, Any] | None:
    """Map one iTunes record to the WildString result shape, dropping unusable ones."""
    if not isinstance(raw, dict):
        return None
    feed_url = _public_url(raw.get("feedUrl"))
    key = normalize_feed_url(feed_url)
    itunes_id = valid_itunes_id(raw.get("collectionId"))
    title = _text(raw.get("collectionName") or raw.get("trackName"), 300)
    if not key or not title:
        return None
    artwork = _public_url(raw.get("artworkUrl600"))
    if not artwork:
        small = raw.get("artworkUrl100") or raw.get("artworkUrl60") or ""
        artwork = _public_url(small.replace("100x100bb", "600x600bb") if small else "")
    genres = []
    for genre in [raw.get("primaryGenreName"), *(raw.get("genres") or [])]:
        name = _text(genre, 60)
        if name and name.lower() != "podcasts" and name not in genres:
            genres.append(name)
    count = raw.get("trackCount")
    return {
        "itunes_id": itunes_id,
        "title": title,
        "author": _text(raw.get("artistName"), 300),
        "artwork_url": artwork,
        "feed_url": feed_url,
        "genres": genres[:4],
        "episode_count": count if isinstance(count, int) and count >= 0 else None,
        "explicit": raw.get("collectionExplicitness") == "explicit",
        "latest_release_at": _text(raw.get("releaseDate"), 40) or None,
        "page_url": _public_url(raw.get("collectionViewUrl")),
        "_key": key,
    }


def episode_time(value: str | None) -> float:
    if not value:
        return 0.0
    try:
        return parsedate_to_datetime(value).timestamp()
    except (TypeError, ValueError, IndexError):
        pass
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def merge_regions(per_region: list[tuple[str, list[dict[str, Any]]]]) -> list[dict[str, Any]]:
    """Merge storefront lists by normalized feed URL or iTunes id, keeping best rank."""
    merged: list[dict[str, Any]] = []
    by_key: dict[str, dict[str, Any]] = {}
    by_id: dict[str, dict[str, Any]] = {}
    for region, items in per_region:
        for rank, item in enumerate(items):
            existing = by_key.get(item["_key"]) or (
                by_id.get(item["itunes_id"]) if item["itunes_id"] else None
            )
            if existing is None:
                existing = {**item, "regions": [], "_rank": rank, "_ids": set()}
                merged.append(existing)
            if region not in existing["regions"]:
                existing["regions"].append(region)
            existing["_rank"] = min(existing["_rank"], rank)
            if item["itunes_id"]:
                existing["_ids"].add(item["itunes_id"])
                by_id.setdefault(item["itunes_id"], existing)
            by_key.setdefault(item["_key"], existing)
    order = {id(item): index for index, item in enumerate(merged)}
    merged.sort(key=lambda item: (item["_rank"], -len(item["regions"]), order[id(item)]))
    return merged


class PodcastPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    feed_url: str = Field(min_length=5, max_length=1024)
    itunes_id: str | None = Field(default=None, pattern=r"^[1-9][0-9]{0,19}$")

    @field_validator("feed_url")
    @classmethod
    def validate_feed_url(cls, value: str) -> str:
        return podcast_module.validate_remote_url(value)


class PodcastSearch:
    """Search, preview and verify iTunes ids with one shared budget and cache."""

    def __init__(
        self,
        manager,
        *,
        regions: str | Iterable[str] = DEFAULT_REGIONS,
        gate: SearchGate | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.manager = manager
        self.database = manager.database
        self.default_regions = parse_regions(regions)
        self.clock = clock
        self.gate = gate or SearchGate(clock=clock)
        self.lock = threading.Lock()
        self.cache: OrderedDict[tuple[str, str, int], tuple[float, list[dict[str, Any]]]] = (
            OrderedDict()
        )
        self.previews: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
        self.seen_ids: dict[str, tuple[float, set[str]]] = {}

    # Settings ---------------------------------------------------------------------------
    def settings(self) -> dict[str, Any]:
        return {"regions": list(self.default_regions), "filter_explicit": False}

    # Cache ------------------------------------------------------------------------------
    def _cached(self, key):
        with self.lock:
            hit = self.cache.get(key)
            if hit is None or hit[0] <= self.clock():
                self.cache.pop(key, None)
                return None
            self.cache.move_to_end(key)
            return hit[1]

    def _store(self, key, items):
        expires = self.clock() + RESULT_TTL_SECONDS
        with self.lock:
            self.cache[key] = (expires, items)
            self.cache.move_to_end(key)
            while len(self.cache) > 512:
                self.cache.popitem(last=False)
        self._remember(items)

    # Upstream ---------------------------------------------------------------------------
    def _region(self, region: str, term: str, limit: int) -> list[dict[str, Any]]:
        query = urlencode(
            {
                "term": term,
                "country": region,
                "media": "podcast",
                "entity": "podcast",
                "limit": limit,
            }
        )
        proxy_mode, proxy_url = self.manager.get_network_policy()
        payload = fetch_itunes_json(f"{ITUNES_SEARCH_URL}?{query}", proxy_mode, proxy_url)
        return [item for raw in payload["results"] if (item := clean_result(raw))]

    def lookup(self, itunes_id: str) -> list[dict[str, Any]]:
        """Return iTunes records for one id, spending one call from the shared budget."""
        self.gate.reserve_upstream(1)
        proxy_mode, proxy_url = self.manager.get_network_policy()
        query = urlencode({"id": itunes_id, "entity": "podcast"})
        try:
            payload = fetch_itunes_json(f"{ITUNES_LOOKUP_URL}?{query}", proxy_mode, proxy_url)
        except UpstreamFailure as exc:
            if exc.code == "upstream_rate_limited":
                self.gate.cool_down(max(THROTTLE_COOLDOWN_SECONDS, exc.retry_after or 0))
            raise
        records = [item for raw in payload["results"] if (item := clean_result(raw))]
        self._remember(records)
        return records

    def _remember(self, items):
        expires = self.clock() + RESULT_TTL_SECONDS
        with self.lock:
            for item in items:
                if item["itunes_id"]:
                    keys = self.seen_ids.get(item["itunes_id"], (0, set()))[1]
                    self.seen_ids[item["itunes_id"]] = (expires, keys | {item["_key"]})
            if len(self.seen_ids) > 8192:
                now = self.clock()
                for stale in [k for k, v in self.seen_ids.items() if v[0] <= now]:
                    self.seen_ids.pop(stale, None)

    def search_directory(
        self, term: str, regions: Iterable[str], limit: int
    ) -> tuple[list[dict[str, Any]], list[dict[str, str]], bool]:
        """Return merged results, failed storefronts and whether everything was cached."""
        term_key = term.casefold()
        found: dict[str, list[dict[str, Any]]] = {}
        needed = []
        for region in regions:
            hit = self._cached((region, term_key, limit))
            if hit is None:
                needed.append(region)
            else:
                found[region] = hit
        failures: dict[str, UpstreamFailure] = {}
        if needed:
            self.gate.reserve_upstream(len(needed))
            with ThreadPoolExecutor(max_workers=len(needed)) as pool:
                futures = {
                    region: pool.submit(self._region, region, term, limit) for region in needed
                }
            for region, future in futures.items():
                try:
                    found[region] = future.result()
                    self._store((region, term_key, limit), found[region])
                except UpstreamFailure as exc:
                    failures[region] = exc
                except Exception:
                    logger.exception("Unexpected podcast directory failure region=%s", region)
                    failures[region] = UpstreamFailure("upstream_failed")
        throttled = [f for f in failures.values() if f.code == "upstream_rate_limited"]
        if throttled:
            self.gate.cool_down(
                max(THROTTLE_COOLDOWN_SECONDS, *(f.retry_after or 0 for f in throttled))
            )
        ordered = [(region, found[region]) for region in regions if region in found]
        failed = [
            {"region": region, "code": failures[region].code}
            for region in regions
            if region in failures
        ]
        if not ordered and failures:
            if throttled:
                raise SearchRateLimited(THROTTLE_COOLDOWN_SECONDS, upstream=True)
            if all(f.code == "timeout" for f in failures.values()):
                raise HTTPException(504, "podcast_search_timeout")
            raise HTTPException(502, "podcast_search_upstream_failed")
        return merge_regions(ordered), failed, not needed

    def verify_itunes_id(self, itunes_id: str | None, *urls: str | None) -> str | None:
        """Accept a client-supplied id only when Apple lists the same feed for it."""
        itunes_id = valid_itunes_id(itunes_id)
        keys = feed_keys(*urls)
        if not itunes_id or not keys:
            return None
        with self.lock:
            seen = self.seen_ids.get(itunes_id)
            if seen and seen[0] > self.clock() and seen[1] & keys:
                return itunes_id
        try:
            records = self.lookup(itunes_id)
        except (SearchRateLimited, UpstreamFailure):
            return None
        return itunes_id if any(item["_key"] in keys for item in records) else None

    # Catalog state ----------------------------------------------------------------------
    def annotate(self, user_id: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        keys = sorted({key for item in items for key in [item["_key"]]})
        ids = sorted({value for item in items for value in item.get("_ids", ()) if value})
        matches: dict[str, str] = {}
        with self.database.connect() as db:
            visible = None if catalog_manager(db, user_id) else personal_ids(db, user_id)
            rows = []
            if keys or ids:
                key_marks = ",".join("?" * len(keys)) or "NULL"
                id_marks = ",".join("?" * len(ids)) or "NULL"
                rows = db.execute(
                    f"""SELECT id,itunes_id,feed_url,feed_url_normalized,
                    resolved_feed_url_normalized FROM podcasts
                    WHERE feed_url_normalized IN ({key_marks})
                    OR resolved_feed_url_normalized IN ({key_marks})
                    OR itunes_id IN ({id_marks}) ORDER BY created_at""",  # nosec B608
                    (*keys, *keys, *ids),
                ).fetchall()
            for row in rows:
                for value in (
                    row["feed_url_normalized"],
                    row["resolved_feed_url_normalized"],
                    normalize_feed_url(row["feed_url"]),
                ):
                    if value:
                        matches.setdefault(f"url:{value}", row["id"])
                if row["itunes_id"]:
                    matches.setdefault(f"id:{row['itunes_id']}", row["id"])
        follows = followed_ids(self.database, user_id)
        output = []
        for item in items:
            podcast_id = matches.get(f"url:{item['_key']}") or next(
                (matches[f"id:{i}"] for i in sorted(item.get("_ids", ())) if f"id:{i}" in matches),
                None,
            )
            if podcast_id is not None and visible is not None and podcast_id not in visible:
                podcast_id = None
            public = {k: v for k, v in item.items() if not k.startswith("_")}
            public["in_catalog"] = podcast_id is not None
            public["catalog_podcast_id"] = podcast_id
            public["followed"] = podcast_id in follows if podcast_id else False
            output.append(public)
        return output

    def catalog_match(self, user_id: str, *urls: str | None) -> dict[str, Any]:
        keys = feed_keys(*urls)
        if not keys:
            return {"in_catalog": False, "catalog_podcast_id": None, "followed": False}
        probe = [{"_key": key, "_ids": set()} for key in sorted(keys)]
        for state in self.annotate(user_id, probe):
            if state["in_catalog"]:
                return {k: state[k] for k in ("in_catalog", "catalog_podcast_id", "followed")}
        return {"in_catalog": False, "catalog_podcast_id": None, "followed": False}

    # Public operations ------------------------------------------------------------------
    def search(self, user: dict, q: str, limit: int) -> dict[str, Any]:
        term = " ".join(q.split())
        if not 1 <= len(term) <= 100:
            raise HTTPException(422, "podcast_search_query_invalid")
        if term.lower().startswith(("http://", "https://")):
            raise HTTPException(422, "podcast_search_query_is_url")
        settings = self.settings()
        regions = tuple(settings["regions"])
        self.gate.admit_user(f"search:{user['id']}")
        items, failed, cached = self.search_directory(term, regions, limit)
        hidden = 0
        if settings["filter_explicit"]:
            hidden = sum(1 for item in items if item["explicit"])
            items = [item for item in items if not item["explicit"]]
        return {
            "query": term,
            "provider": "itunes",
            "regions": list(regions),
            "failed_regions": failed,
            "cached": cached,
            "explicit_hidden": hidden,
            "results": self.annotate(user["id"], items),
        }

    def preview(self, user: dict, feed_url: str) -> dict[str, Any]:
        key = normalize_feed_url(feed_url)
        with self.lock:
            hit = self.previews.get(key)
            parsed = hit[1] if hit and hit[0] > self.clock() else None
        if parsed is None:
            self.gate.admit_user(f"preview:{user['id']}", USER_PREVIEWS_PER_MINUTE)
            proxy_mode, proxy_url = self.manager.get_network_policy()
            parsed = podcast_module.fetch_and_parse_feed(
                feed_url, timeout=15, proxy_mode=proxy_mode, proxy_url=proxy_url
            )
            with self.lock:
                self.previews[key] = (self.clock() + PREVIEW_TTL_SECONDS, parsed)
                while len(self.previews) > 128:
                    self.previews.popitem(last=False)
        episodes = parsed["episodes"]
        latest = sorted(
            episodes,
            key=lambda ep: episode_time(ep.get("pub_date")),
            reverse=True,
        )[:PREVIEW_EPISODES]
        resolved = parsed.get("resolved_url") or feed_url
        return {
            "feed_url": feed_url,
            "resolved_feed_url": resolved,
            "title": parsed["title"],
            "author": parsed["author"],
            "description": parsed["description"][:4000],
            "cover_url": parsed["cover_url"],
            "episode_count": len(episodes),
            "latest_episodes": [
                {
                    "title": ep["title"],
                    "pub_date": ep["pub_date"] or None,
                    "duration_seconds": ep["duration_seconds"] or None,
                }
                for ep in latest
            ],
            **self.catalog_match(user["id"], feed_url, resolved),
        }

    def routes(self, router: APIRouter, auth) -> None:
        @router.get("/search")
        def search_directory(
            user: Annotated[dict, Depends(auth.require_session)],
            q: Annotated[str, Query(min_length=1, max_length=200)],
            limit: Annotated[int, Query(ge=1, le=50)] = 25,
        ):
            try:
                return self.search(user, q, limit)
            except SearchRateLimited as exc:
                raise rate_limited(exc) from None

        @router.post("/preview", dependencies=[Depends(auth.require_client)])
        def preview_feed(
            body: PodcastPreviewRequest,
            user: Annotated[dict, Depends(auth.require_session)],
        ):
            try:
                return self.preview(user, body.feed_url)
            except SearchRateLimited as exc:
                raise rate_limited(exc) from None


def rate_limited(exc: SearchRateLimited) -> HTTPException:
    code = "podcast_search_upstream_rate_limited" if exc.upstream else "podcast_search_rate_limited"
    return HTTPException(
        429,
        {"code": code, "retry_after": exc.retry_after},
        headers={"Retry-After": str(exc.retry_after)},
    )
