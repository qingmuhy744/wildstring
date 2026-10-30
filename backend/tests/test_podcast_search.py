"""Directory search stays bounded, honest about failures and never trusts titles."""

import json
import sqlite3
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from wildstring import podcast_search
from wildstring.database import SCHEMA_VERSION, Database
from wildstring.podcast_identity import normalize_feed_url
from wildstring.podcast_search import (
    SearchGate,
    SearchRateLimited,
    UpstreamFailure,
    clean_result,
    merge_regions,
    parse_regions,
)

HEADERS = {"X-Wildstring-Client": "web"}
FIXTURES = Path(__file__).parent / "fixtures" / "itunes"
TERMS = {"声东击西": "shengdongjixi", "王局拍案": "wangju"}
FIRESIDE = "https://feeds.fireside.fm/shengdongjixi/rss"


def fixture(name):
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


class FakeItunes:
    """Serve recorded iTunes responses and count every upstream call."""

    def __init__(self, failures=None):
        self.calls = []
        self.failures = failures or {}

    def __call__(self, url, _proxy_mode, _proxy_url):
        parts = urlsplit(url)
        query = {key: values[0] for key, values in parse_qs(parts.query).items()}
        self.calls.append((parts.path, query))
        if parts.path == "/lookup":
            path = FIXTURES / f"lookup_{query['id']}.json"
            return json.loads(path.read_text()) if path.exists() else {"results": []}
        region = query["country"]
        if region in self.failures:
            raise self.failures[region]
        slug = TERMS.get(query["term"])
        return fixture(f"{slug}_{region}") if slug else {"resultCount": 0, "results": []}


def feed(title="声东击西", episodes=7, resolved=None):
    return {
        "title": title,
        "author": "ETW Studio",
        "description": "关于声音的节目",
        "cover_url": "",
        "new_feed_url": "",
        "resolved_url": resolved,
        "episodes": [
            {
                "guid": f"guid-{index}",
                "title": f"第 {index} 期",
                "description": "",
                "audio_url": f"https://media.example.com/{index}.mp3",
                "duration_seconds": 60 * index,
                "pub_date": f"Mon, {index:02d} Jun 2026 08:00:00 +0000",
                "episode_number": index,
                "season_number": None,
            }
            for index in range(1, episodes + 1)
        ],
    }


@pytest.fixture
def itunes(monkeypatch):
    fake = FakeItunes()
    monkeypatch.setattr(podcast_search, "fetch_itunes_json", fake)
    monkeypatch.setattr(
        "wildstring.podcasts.PodcastManager.queue_download_episode", lambda *_a, **_k: True
    )
    return fake


@pytest.fixture
def feeds(monkeypatch):
    fetched = []

    def fetch(url, **_kwargs):
        fetched.append(url)
        if "etw.fm" in url:
            return feed(resolved=FIRESIDE)
        if "broken" in url:
            raise HTTPException(502, "podcast_feed_fetch_failed")
        return feed(resolved=url)

    monkeypatch.setattr("wildstring.podcasts.fetch_and_parse_feed", fetch)
    return fetched


def search(client, q, **params):
    return client.get("/api/v1/podcasts/search", params={"q": q, **params})


def test_feed_urls_normalize_without_dropping_meaningful_parts():
    assert normalize_feed_url("HTTPS://Feeds.Fireside.FM:443/shengdongjixi/rss/") == (
        "feeds.fireside.fm/shengdongjixi/rss"
    )
    assert normalize_feed_url("http://feeds.fireside.fm//shengdongjixi/rss#top") == (
        normalize_feed_url(FIRESIDE)
    )
    assert normalize_feed_url("https://example.com:8443/feed?id=7") == "example.com:8443/feed?id=7"
    assert normalize_feed_url("https://example.com/feed?id=7") != normalize_feed_url(
        "https://example.com/feed?id=8"
    )
    assert normalize_feed_url("ftp://example.com/rss") == ""
    assert normalize_feed_url("https://example.com:99999/rss") == ""


def test_regions_are_validated_in_configured_order():
    assert parse_regions(" US,tw,cn,us ") == ("us", "tw", "cn")
    for bad in ("", "xx", "us,zz", "us,tw,cn,jp,hk,gb"):
        with pytest.raises(ValueError, match="podcast_search_region_invalid"):
            parse_regions(bad)


def test_recorded_regions_merge_by_feed_and_keep_region_labels():
    per_region = [
        (
            region,
            [
                item
                for raw in fixture(f"shengdongjixi_{region}")["results"]
                if (item := clean_result(raw))
            ],
        )
        for region in ("us", "tw", "cn")
    ]
    merged = merge_regions(per_region)
    assert [item["title"] for item in merged] == ["声东击西", "声东击西小杨说"]
    show, other = merged
    assert show["regions"] == ["us", "tw", "cn"]
    assert show["itunes_id"] == "1183662640"
    assert show["feed_url"] == FIRESIDE
    assert show["artwork_url"].startswith("https://")
    assert show["explicit"] is False
    assert other["regions"] == ["us", "tw"]
    # Three iTunes collections share one anchor feed and must collapse into one card.
    assert len(other["_ids"]) == 3


def test_items_without_a_public_feed_are_dropped():
    assert clean_result({"collectionName": "No feed", "collectionId": 1}) is None
    assert clean_result({"collectionName": "Local", "feedUrl": "http://127.0.0.1/rss"}) is None
    assert clean_result({"collectionName": "", "feedUrl": FIRESIDE}) is None
    explicit = clean_result(
        {"collectionName": "Loud", "feedUrl": FIRESIDE, "collectionExplicitness": "explicit"}
    )
    assert explicit["explicit"] is True


def test_search_api_merges_regions_and_caches(settings, authenticated_client, itunes):
    with authenticated_client(settings) as client:
        response = search(client, "  声东击西 ")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["query"] == "声东击西"
        assert body["regions"] == ["us", "tw", "cn"]
        assert body["failed_regions"] == []
        assert body["cached"] is False
        first = body["results"][0]
        assert first["title"] == "声东击西"
        assert first["regions"] == ["us", "tw", "cn"]
        assert first["episode_count"] == 434 or first["episode_count"] > 0
        assert first["in_catalog"] is False and first["followed"] is False
        assert all(not key.startswith("_") for key in first)
        assert len(itunes.calls) == 3

        cached = search(client, "声东击西")
        assert cached.json()["cached"] is True
        assert cached.json()["results"] == body["results"]
        assert len(itunes.calls) == 3

        wang = search(client, "王局拍案").json()
        assert [item["regions"] for item in wang["results"]] == [["us", "tw"]]
        assert wang["results"][0]["title"].startswith("「王局拍案」")

        empty = search(client, "没有这个节目").json()
        assert empty["results"] == [] and empty["failed_regions"] == []


def test_search_rejects_invalid_queries(settings, authenticated_client, itunes):
    with authenticated_client(settings) as client:
        assert search(client, "   ").json()["detail"] == "podcast_search_query_invalid"
        assert search(client, "x" * 101).json()["detail"] == "podcast_search_query_invalid"
        url = search(client, "https://etw.fm/rss")
        assert url.status_code == 422 and url.json()["detail"] == "podcast_search_query_is_url"
        assert client.get("/api/v1/podcasts/search").status_code == 422
        assert itunes.calls == []
        anonymous = TestClient(client.app)
        assert search(anonymous, "声东击西").status_code == 401


def test_partial_and_total_upstream_failures_are_reported(settings, authenticated_client, itunes):
    itunes.failures = {"cn": UpstreamFailure("timeout")}
    with authenticated_client(settings) as client:
        partial = search(client, "声东击西").json()
        assert partial["failed_regions"] == [{"region": "cn", "code": "timeout"}]
        assert partial["results"][0]["regions"] == ["us", "tw"]

        itunes.failures = {region: UpstreamFailure("timeout") for region in ("us", "tw", "cn")}
        timeout = search(client, "王局拍案")
        assert timeout.status_code == 504
        assert timeout.json()["detail"] == "podcast_search_timeout"

        itunes.failures = {
            "us": UpstreamFailure("timeout"),
            "tw": UpstreamFailure("upstream_http_error"),
            "cn": UpstreamFailure("dns_error"),
        }
        failed = search(client, "另一个节目")
        assert failed.status_code == 502
        assert failed.json()["detail"] == "podcast_search_upstream_failed"


def test_upstream_throttling_starts_a_cooldown(settings, authenticated_client, itunes):
    itunes.failures = {
        region: UpstreamFailure("upstream_rate_limited", 90) for region in ("us", "tw", "cn")
    }
    with authenticated_client(settings) as client:
        throttled = search(client, "声东击西")
        assert throttled.status_code == 429
        assert throttled.json()["detail"]["code"] == "podcast_search_upstream_rate_limited"
        assert int(throttled.headers["Retry-After"]) >= 60
        calls = len(itunes.calls)
        itunes.failures = {}
        again = search(client, "王局拍案")
        assert again.status_code == 429
        assert len(itunes.calls) == calls


def test_gate_counts_each_region_call_and_each_user():
    clock = [1000.0]
    gate = SearchGate(upstream_per_minute=6, user_per_minute=2, clock=lambda: clock[0])
    gate.reserve_upstream(3)
    gate.reserve_upstream(3)
    with pytest.raises(SearchRateLimited) as exc:
        gate.reserve_upstream(3)
    assert exc.value.upstream and exc.value.retry_after == 60
    clock[0] += 61
    gate.reserve_upstream(3)

    gate.admit_user("a")
    gate.admit_user("a")
    with pytest.raises(SearchRateLimited) as exc:
        gate.admit_user("a")
    assert exc.value.upstream is False
    gate.admit_user("b")
    clock[0] += 60
    gate.admit_user("a")


def test_api_reports_upstream_budget_with_retry_after(settings, authenticated_client, itunes):
    with authenticated_client(settings) as client:
        for index in range(6):
            assert search(client, f"节目{index}").status_code == 200
        limited = search(client, "节目-over")
        assert limited.status_code == 429
        assert limited.json()["detail"] == {
            "code": "podcast_search_upstream_rate_limited",
            "retry_after": int(limited.headers["Retry-After"]),
        }
        # Cached searches stay available while the upstream budget is exhausted.
        assert search(client, "节目0").status_code == 200
        assert len(itunes.calls) == 18


def test_per_user_limit(settings, authenticated_client, itunes, monkeypatch):
    monkeypatch.setattr(podcast_search, "USER_SEARCHES_PER_MINUTE", 2)
    with authenticated_client(settings) as client:
        assert search(client, "声东击西").status_code == 200
        assert search(client, "声东击西").status_code == 200
        limited = search(client, "声东击西")
        assert limited.status_code == 429
        assert limited.json()["detail"]["code"] == "podcast_search_rate_limited"


def test_fetch_maps_apple_errors(monkeypatch):
    def throttled(*_args, **_kwargs):
        raise HTTPError("https://itunes.apple.com/search", 403, "Forbidden", {}, None)

    monkeypatch.setattr(podcast_search, "request_bytes", throttled)
    with pytest.raises(UpstreamFailure) as exc:
        podcast_search.fetch_itunes_json("https://itunes.apple.com/search", "direct", None)
    assert exc.value.code == "upstream_rate_limited"

    monkeypatch.setattr(podcast_search, "request_bytes", lambda *_a, **_k: (200, {}, b"<html>"))
    with pytest.raises(UpstreamFailure) as exc:
        podcast_search.fetch_itunes_json("https://itunes.apple.com/search", "direct", None)
    assert exc.value.code == "upstream_invalid_response"

    seen = {}

    def capture(request, **kwargs):
        seen.update(kwargs, url=request.full_url)
        return 200, {}, b'{"resultCount":0,"results":[]}'

    monkeypatch.setattr(podcast_search, "request_bytes", capture)
    assert podcast_search.fetch_itunes_json("https://itunes.apple.com/search?x=1", "direct", None)
    assert seen["service"] == "podcast_search" and "redirect" not in seen
    assert seen["timeout"] == podcast_search.UPSTREAM_TIMEOUT_SECONDS


def test_preview_does_not_persist_and_reports_catalog_state(
    settings, authenticated_client, itunes, feeds
):
    with authenticated_client(settings) as client:
        preview = client.post(
            "/api/v1/podcasts/preview", headers=HEADERS, json={"feed_url": "https://etw.fm/rss"}
        )
        assert preview.status_code == 200, preview.text
        body = preview.json()
        assert body["title"] == "声东击西" and body["episode_count"] == 7
        assert [ep["title"] for ep in body["latest_episodes"]] == [
            "第 7 期",
            "第 6 期",
            "第 5 期",
            "第 4 期",
            "第 3 期",
        ]
        assert body["resolved_feed_url"] == FIRESIDE
        assert body["in_catalog"] is False
        assert client.get("/api/v1/podcasts").json() == []
        client.post(
            "/api/v1/podcasts/preview", headers=HEADERS, json={"feed_url": "https://etw.fm/rss/"}
        )
        assert feeds == ["https://etw.fm/rss"]

        broken = client.post(
            "/api/v1/podcasts/preview",
            headers=HEADERS,
            json={"feed_url": "https://broken.example.com/rss"},
        )
        assert broken.status_code == 502
        assert broken.json()["detail"] == "podcast_feed_fetch_failed"
        local = client.post(
            "/api/v1/podcasts/preview", headers=HEADERS, json={"feed_url": "http://127.0.0.1/rss"}
        )
        assert local.status_code == 422

        added = client.post(
            "/api/v1/podcasts",
            headers=HEADERS,
            json={"feed_url": FIRESIDE, "itunes_id": "1183662640"},
        )
        assert added.status_code == 200, added.text
        podcast_id = added.json()["podcast"]["id"]
        again = client.post(
            "/api/v1/podcasts/preview", headers=HEADERS, json={"feed_url": "https://etw.fm/rss"}
        ).json()
        assert again["in_catalog"] is True and again["followed"] is True
        assert again["catalog_podcast_id"] == podcast_id


def test_subscribe_reuses_rows_by_feed_redirect_and_verified_itunes_id(
    settings, authenticated_client, itunes, feeds
):
    with authenticated_client(settings) as client:
        database = Database(settings.data_dir)
        found = search(client, "声东击西").json()["results"][0]
        added = client.post(
            "/api/v1/podcasts",
            headers=HEADERS,
            json={"feed_url": found["feed_url"], "itunes_id": found["itunes_id"]},
        )
        assert added.status_code == 200, added.text
        podcast_id = added.json()["podcast"]["id"]
        with database.connect() as db:
            row = db.execute("SELECT * FROM podcasts WHERE id=?", (podcast_id,)).fetchone()
        assert row["itunes_id"] == "1183662640"
        assert row["feed_url_normalized"] == "feeds.fireside.fm/shengdongjixi/rss"
        # The verification came from the cached search result: no lookup call.
        assert all(path != "/lookup" for path, _ in itunes.calls)

        # The old preset URL redirects to the same feed, so it is the same programme.
        preset = client.post(
            "/api/v1/podcasts", headers=HEADERS, json={"feed_url": "https://etw.fm/rss"}
        )
        assert preset.json()["podcast"]["id"] == podcast_id
        # Same id from Apple with a different, case-changed URL also reuses the row.
        variant = client.post(
            "/api/v1/podcasts",
            headers=HEADERS,
            json={"feed_url": "http://FEEDS.fireside.fm/shengdongjixi/rss/"},
        )
        assert variant.json()["podcast"]["id"] == podcast_id
        with database.connect() as db:
            assert db.execute("SELECT COUNT(*) FROM podcasts").fetchone()[0] == 1

        refreshed = search(client, "声东击西").json()["results"][0]
        assert refreshed["in_catalog"] is True and refreshed["followed"] is True
        assert refreshed["catalog_podcast_id"] == podcast_id


def test_unverified_itunes_id_is_not_stored(settings, authenticated_client, itunes, feeds):
    with authenticated_client(settings) as client:
        database = Database(settings.data_dir)
        # Apple lists id 1183662640 for the fireside feed, not for this one.
        added = client.post(
            "/api/v1/podcasts",
            headers=HEADERS,
            json={"feed_url": "https://other.example.com/rss", "itunes_id": "1183662640"},
        )
        assert added.status_code == 200, added.text
        assert ("/lookup", {"id": "1183662640", "entity": "podcast"}) in itunes.calls
        with database.connect() as db:
            assert db.execute("SELECT itunes_id FROM podcasts").fetchone()[0] is None
        # A later real addition by id is therefore not hijacked by the wrong row.
        real = client.post(
            "/api/v1/podcasts",
            headers=HEADERS,
            json={"feed_url": FIRESIDE, "itunes_id": "1183662640"},
        )
        assert real.json()["podcast"]["id"] != added.json()["podcast"]["id"]
        bad = client.post(
            "/api/v1/podcasts", headers=HEADERS, json={"feed_url": FIRESIDE, "itunes_id": "abc"}
        )
        assert bad.status_code == 422


def test_listeners_can_search_but_only_see_their_own_catalog_state(
    settings, authenticated_client, itunes, feeds
):
    with authenticated_client(settings) as client:
        assert (
            client.post(
                "/api/v1/podcasts", headers=HEADERS, json={"feed_url": FIRESIDE}
            ).status_code
            == 200
        )
        created = client.post(
            "/api/v1/manage/users",
            headers=HEADERS,
            json={"username": "listener", "password": "listener-password-1", "library_ids": []},
        )
        assert created.status_code == 201
        listener = TestClient(client.app)
        assert (
            listener.post(
                "/api/v1/auth/login",
                headers=HEADERS,
                json={"username": "listener", "password": "listener-password-1"},
            ).status_code
            == 200
        )
        try:
            result = search(listener, "声东击西")
            assert result.status_code == 200
            first = result.json()["results"][0]
            assert first["in_catalog"] is False and first["catalog_podcast_id"] is None
            # Adding still follows the catalog policy (closed by default).
            denied = listener.post(
                "/api/v1/podcasts",
                headers=HEADERS,
                json={"feed_url": FIRESIDE, "itunes_id": "1183662640"},
            )
            assert denied.status_code == 403
            assert denied.json()["detail"] == "podcast_subscriptions_disabled"
            preview = listener.post(
                "/api/v1/podcasts/preview", headers=HEADERS, json={"feed_url": FIRESIDE}
            )
            assert preview.status_code == 200
        finally:
            listener.close()


def test_schema_43_adds_identity_columns(settings):
    database = Database(settings.data_dir)
    database.initialize()
    with sqlite3.connect(database.path) as db:
        db.execute("PRAGMA user_version=42")
        db.execute("DROP INDEX podcasts_by_itunes_id")
    database.initialize()
    with database.connect() as db:
        columns = {row[1] for row in db.execute("PRAGMA table_info(podcasts)")}
        assert {"itunes_id", "feed_url_normalized", "resolved_feed_url_normalized"} <= columns
        assert db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        indexes = {row[1] for row in db.execute("PRAGMA index_list(podcasts)")}
        assert "podcasts_by_itunes_id" in indexes


def test_owner_settings_choose_regions_and_hide_explicit_shows(
    settings, authenticated_client, itunes, monkeypatch
):
    def explicit_first(url, proxy_mode, proxy_url):
        body = itunes(url, proxy_mode, proxy_url)
        for item in body.get("results", [])[:1]:
            item["collectionExplicitness"] = "explicit"
        return body

    monkeypatch.setattr(podcast_search, "fetch_itunes_json", explicit_first)
    with authenticated_client(settings) as client:
        current = client.get("/api/v1/podcasts/search-settings").json()
        assert current["regions"] == ["us", "tw", "cn"]
        assert current["custom_regions"] is False and current["filter_explicit"] is False
        assert current["can_manage"] is True and "jp" in current["supported_regions"]

        badge_only = search(client, "声东击西").json()
        assert badge_only["explicit_hidden"] == 0
        assert any(item["explicit"] for item in badge_only["results"])

        url = "/api/v1/podcasts/search-settings"
        bad = client.put(
            url,
            headers=HEADERS,
            json={"version": current["version"], "regions": ["xx"], "filter_explicit": False},
        )
        assert bad.status_code == 422 and bad.json()["detail"] == "podcast_search_region_invalid"
        too_many = client.put(
            url,
            headers=HEADERS,
            json={
                "version": current["version"],
                "regions": ["us", "tw", "cn", "hk", "jp", "sg"],
                "filter_explicit": False,
            },
        )
        assert too_many.status_code == 422
        updated = client.put(
            url,
            headers=HEADERS,
            json={
                "version": current["version"],
                "regions": ["TW", "us", "tw"],
                "filter_explicit": True,
            },
        )
        assert updated.status_code == 200, updated.text
        body = updated.json()
        assert body["regions"] == ["tw", "us"] and body["custom_regions"] is True
        assert body["filter_explicit"] is True and body["version"] == current["version"] + 1
        stale = client.put(
            url,
            headers=HEADERS,
            json={"version": current["version"], "regions": None, "filter_explicit": False},
        )
        assert stale.status_code == 409
        assert stale.json()["detail"] == "podcast_search_settings_conflict"

        itunes.calls.clear()
        filtered = search(client, "王局拍案").json()
        assert filtered["regions"] == ["tw", "us"]
        assert sorted(call[1]["country"] for call in itunes.calls) == ["tw", "us"]
        assert filtered["explicit_hidden"] >= 1
        assert not any(item["explicit"] for item in filtered["results"])

        reset = client.put(
            url,
            headers=HEADERS,
            json={"version": body["version"], "regions": [], "filter_explicit": False},
        ).json()
        assert reset["regions"] == ["us", "tw", "cn"] and reset["custom_regions"] is False

        created = client.post(
            "/api/v1/manage/users",
            headers=HEADERS,
            json={"username": "regions", "password": "listener-password-1", "library_ids": []},
        )
        assert created.status_code == 201
        listener = TestClient(client.app)
        try:
            listener.post(
                "/api/v1/auth/login",
                headers=HEADERS,
                json={"username": "regions", "password": "listener-password-1"},
            )
            assert listener.get(url).json()["can_manage"] is False
            denied = listener.put(
                url,
                headers=HEADERS,
                json={"version": reset["version"], "regions": ["us"], "filter_explicit": True},
            )
            assert denied.status_code == 403
        finally:
            listener.close()


def test_schema_44_seeds_default_search_settings(settings):
    database = Database(settings.data_dir)
    database.initialize()
    with sqlite3.connect(database.path) as db:
        db.execute("DROP TABLE podcast_search_settings")
        db.execute("PRAGMA user_version=43")
    database.initialize()
    with sqlite3.connect(database.path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        row = db.execute(
            "SELECT regions, filter_explicit, version FROM podcast_search_settings"
        ).fetchall()
    assert row == [(None, 0, 1)]
