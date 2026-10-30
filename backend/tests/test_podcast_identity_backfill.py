"""Backfilling directory ids for old rows never trusts titles, and merges only verified rows."""

import sqlite3
import time
from contextlib import closing

import pytest
import test_podcast_search as search_support

from wildstring import podcast_identity_backfill
from wildstring.database import SCHEMA_VERSION, Database
from wildstring.podcasts import podcast_folder_name

itunes = search_support.itunes
feeds = search_support.feeds
HEADERS = search_support.HEADERS
FIRESIDE = search_support.FIRESIDE
SHENGDONG = "1183662640"
API = "/api/v1/podcasts/identity"


@pytest.fixture(autouse=True)
def fast_feed_checks(monkeypatch):
    monkeypatch.setattr(podcast_identity_backfill, "FEED_FETCH_INTERVAL_SECONDS", 0)


def connect(settings):
    connection = sqlite3.connect(Database(settings.data_dir).path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return closing(connection)


def legacy_show(db, podcast_id, title, feed_url, author="ETW Studio", created="2025-01-01"):
    """Insert a row the way releases before schema 43 left it: no identity columns."""
    db.execute(
        """INSERT INTO podcasts(id,title,author,feed_url,created_at,itunes_id,
        feed_url_normalized,resolved_feed_url_normalized,itunes_check_status)
        VALUES (?,?,?,?,?,NULL,NULL,NULL,NULL)""",
        (podcast_id, title, author, feed_url, created),
    )


def episode(db, episode_id, podcast_id, guid, *, local_path=None, status="none"):
    db.execute(
        """INSERT INTO podcast_episodes(id,podcast_id,guid,title,audio_url,created_at,
        local_path,download_status) VALUES (?,?,?,?,?,?,?,?)""",
        (
            episode_id,
            podcast_id,
            guid,
            guid,
            f"https://media.example.com/{podcast_id}/{guid}.mp3",
            "2025-01-01",
            local_path,
            status,
        ),
    )


def progress(db, user_id, episode_id, position, listened_at):
    db.execute(
        """INSERT INTO podcast_progress(user_id,episode_id,position_seconds,duration_seconds,
        last_listened_at,version) VALUES (?,?,?,600,?,1)""",
        (user_id, episode_id, position, listened_at),
    )


def admin_id(db):
    return db.execute("SELECT id FROM users WHERE username='admin'").fetchone()[0]


def run_backfill(client, **body):
    started = client.post(f"{API}/backfill", headers=HEADERS, json=body or None)
    assert started.status_code == 202, started.text
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        status = client.get(f"{API}/backfill").json()
        if not status["running"]:
            return status
        time.sleep(0.02)
    raise AssertionError("backfill did not finish")


def statuses(settings):
    with connect(settings) as db:
        return {
            row["id"]: dict(row)
            for row in db.execute(
                "SELECT id,itunes_id,itunes_check_status,feed_url_normalized,"
                "resolved_feed_url_normalized FROM podcasts"
            )
        }


def test_schema_45_normalises_feeds_already_in_the_catalog(settings):
    database = Database(settings.data_dir)
    database.initialize()
    with connect(settings) as db:
        legacy_show(db, "etw", "声东击西", "HTTPS://ETW.fm/rss/")
        legacy_show(db, "known", "王局拍案", "https://feed.firstory.me/rss/user/x")
        db.execute("UPDATE podcasts SET itunes_id='1623536653' WHERE id='known'")
        db.execute("PRAGMA user_version=44")
        db.commit()
    database.initialize()
    rows = statuses(settings)
    assert rows["etw"]["feed_url_normalized"] == "etw.fm/rss"
    assert rows["etw"]["itunes_check_status"] is None
    assert rows["known"]["itunes_check_status"] == "existing"
    with connect(settings) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION == 45


def test_backfill_accepts_feed_matches_only_and_is_idempotent(
    settings, authenticated_client, itunes, feeds
):
    with authenticated_client(settings) as client:
        with connect(settings) as db:
            legacy_show(db, "etw", "声东击西", "https://etw.fm/rss", created="2024-01-01")
            legacy_show(db, "fireside", "声东击西", FIRESIDE, created="2025-01-01")
            # Same title as an Apple show, different feed: must never borrow its id.
            legacy_show(db, "copy", "王局拍案", "https://mirror.example.com/wangju.xml", "王局千古")
            # Same search term, different programme; Apple lists its feed under three ids.
            legacy_show(
                db, "anchor", "声东击西", "https://anchor.fm/s/10908695c/podcast/rss", "Michelle"
            )
            legacy_show(db, "broken", "无人知晓", "https://broken.example.com/rss", "")
            db.commit()
        status = run_backfill(client)
        assert status["last_run"]["processed"] == 5
        assert status["last_run"]["matched"] == 3
        assert status["last_run"]["no_match"] == 2
        assert status["last_run"]["ambiguous"] == 1
        rows = statuses(settings)
        assert rows["etw"]["itunes_id"] == SHENGDONG
        assert rows["etw"]["resolved_feed_url_normalized"] == "feeds.fireside.fm/shengdongjixi/rss"
        assert rows["fireside"]["itunes_id"] == SHENGDONG
        assert rows["copy"]["itunes_id"] is None
        assert rows["copy"]["itunes_check_status"] == "no_match"
        assert rows["anchor"]["itunes_id"] == "1740872075"
        assert rows["broken"]["itunes_check_status"] == "no_match"
        assert rows["broken"]["resolved_feed_url_normalized"] is None

        calls, fetched = len(itunes.calls), len(feeds)
        again = run_backfill(client)
        assert again["last_run"]["processed"] == 0
        assert (len(itunes.calls), len(feeds)) == (calls, fetched)
        assert again["unchecked"] == 0
        assert again["with_itunes_id"] == 3

        retried = run_backfill(client, retry_unmatched=True, limit=10)
        assert retried["last_run"]["processed"] == 2
        assert statuses(settings)["copy"]["itunes_id"] is None


def test_backfill_waits_for_the_shared_budget_and_leaves_room_for_people(settings, feeds):
    waits = []
    database = Database(settings.data_dir)
    database.initialize()
    with connect(settings) as db:
        legacy_show(db, "fireside", "声东击西", FIRESIDE)
        db.commit()
    backfill = podcast_identity_backfill.IdentityBackfill(
        type("Manager", (), {"database": database})(), None
    )
    clock = [0.0]

    class Search:
        gate = search_support.SearchGate(upstream_per_minute=8, clock=lambda: clock[0])
        attempts = 0

        def settings(self):
            return {"regions": ["us", "tw", "cn"]}

        def search_directory(self, term, regions, limit, *, headroom):
            assert headroom == podcast_identity_backfill.SEARCH_HEADROOM
            Search.attempts += 1
            self.gate.reserve_upstream(len(regions), headroom=headroom)
            return (
                [
                    search_support.clean_result(r)
                    for r in search_support.fixture("shengdongjixi_us")["results"]
                ],
                [],
                False,
            )

    backfill.search = Search()
    # People already spent the budget the job may use this minute.
    Search.gate.reserve_upstream(1)

    def wait(seconds):
        waits.append(seconds)
        clock[0] += seconds
        return False

    backfill.wait = wait
    backfill.manager.get_network_policy = lambda: ("environment", None)
    result = backfill.run(limit=5)
    assert result["last_run"]["matched"] == 1
    assert Search.attempts == 2
    assert waits and waits[0] >= 59
    # The job waited until the interactive call left the window, then spent 3 of 3.
    assert list(Search.gate.upstream) == [60.0, 60.0, 60.0]


def seed_duplicates(settings, storage):
    with connect(settings) as db:
        user = admin_id(db)
        legacy_show(db, "etw", "声东击西", "https://etw.fm/rss", created="2024-01-01")
        legacy_show(db, "fireside", "声东击西", FIRESIDE, created="2025-01-01")
        legacy_show(db, "w1", "王局拍案", "https://a.example.com/wangju.xml", "")
        legacy_show(db, "w2", "「王局拍案」", "https://b.example.com/wangju.xml", "王局千古")
        old_dir = storage / podcast_folder_name("etw")
        new_dir = storage / podcast_folder_name("fireside")
        old_dir.mkdir(parents=True)
        new_dir.mkdir(parents=True)
        files = {
            name: (old_dir if name.startswith("old") else new_dir) / f"{name}.mp3"
            for name in ("old-1", "old-2", "old-3", "new-2")
        }
        for path in files.values():
            path.write_bytes(b"audio")
        # guid-1 exists on both: the old row has the download and the newer progress.
        episode(db, "etw-1", "etw", "guid-1", local_path=str(files["old-1"]), status="downloaded")
        episode(db, "fs-1", "fireside", "guid-1")
        # guid-2 is downloaded on both; the duplicate copy is removed, the kept one stays.
        episode(db, "etw-2", "etw", "guid-2", local_path=str(files["old-2"]), status="downloaded")
        episode(
            db, "fs-2", "fireside", "guid-2", local_path=str(files["new-2"]), status="downloaded"
        )
        # guid-3 only exists in the old feed and moves across untouched.
        episode(db, "etw-3", "etw", "guid-3", local_path=str(files["old-3"]), status="downloaded")
        progress(db, user, "etw-1", 420, "2026-10-01T10:00:00Z")
        progress(db, user, "fs-1", 30, "2026-09-01T10:00:00Z")
        progress(db, user, "etw-2", 10, "2026-01-01T10:00:00Z")
        progress(db, user, "fs-2", 500, "2026-10-02T10:00:00Z")
        progress(db, user, "etw-3", 99, "2026-10-03T10:00:00Z")
        db.execute("INSERT INTO podcast_follows(user_id,podcast_id) VALUES (?, 'etw')", (user,))
        db.execute(
            "INSERT INTO podcast_resource_refs(user_id,episode_id,created_at,manual) "
            "VALUES (?, 'etw-1', 1, 1)",
            (user,),
        )
        db.commit()
    return user, files


def test_duplicates_are_reported_and_only_verified_pairs_merge(
    settings, authenticated_client, itunes, feeds
):
    with authenticated_client(settings) as client:
        user, files = seed_duplicates(settings, settings.podcasts_dir)
        before = client.get(f"{API}/duplicates").json()
        assert before["verified"] == 0
        assert {tuple(sorted(p["id"] for p in d["podcasts"])) for d in before["duplicates"]} == {
            ("etw", "fireside"),
            ("w1", "w2"),
        }
        assert all(d["confidence"] == "possible" for d in before["duplicates"])
        denied = client.post(
            f"{API}/merge", headers=HEADERS, json={"keep_id": "fireside", "merge_id": "etw"}
        )
        assert (denied.status_code, denied.json()["detail"]) == (409, "podcast_merge_unverified")

        run_backfill(client)
        report = client.get(f"{API}/duplicates").json()
        verified = [d for d in report["duplicates"] if d["confidence"] == "verified"]
        assert len(verified) == 1
        pair = verified[0]
        assert pair["itunes_id"] == SHENGDONG
        assert pair["reasons"] == ["feed", "itunes_id", "title"]
        assert pair["suggested_keep_id"] == "fireside"  # etw.fm only redirects there
        wang = [d for d in report["duplicates"] if d["confidence"] == "possible"]
        assert [d["reasons"] for d in wang] == [["title"]]

        with connect(settings) as db:
            db.execute("UPDATE podcast_episodes SET download_status='queued' WHERE id='fs-1'")
            db.commit()
        busy = client.post(
            f"{API}/merge", headers=HEADERS, json={"keep_id": "fireside", "merge_id": "etw"}
        )
        assert (busy.status_code, busy.json()["detail"]) == (409, "podcast_merge_busy")
        with connect(settings) as db:
            db.execute("UPDATE podcast_episodes SET download_status='none' WHERE id='fs-1'")
            db.commit()

        merged = client.post(
            f"{API}/merge", headers=HEADERS, json={"keep_id": "fireside", "merge_id": "etw"}
        )
        assert merged.status_code == 200, merged.text
        assert merged.json() == {
            "kept_id": "fireside",
            "merged_id": "etw",
            "episodes_moved": 1,
            "episodes_matched": 2,
            "progress_moved": 1,
            "progress_replaced": 1,
            "downloads_moved": 2,
            "follows_moved": 1,
        }
        with connect(settings) as db:
            assert db.execute("SELECT COUNT(*) FROM podcasts WHERE id='etw'").fetchone()[0] == 0
            assert (
                db.execute(
                    "SELECT podcast_id FROM podcast_follows WHERE user_id=?", (user,)
                ).fetchall()[0][0]
                == "fireside"
            )
            rows = {
                row["episode_id"]: row["position_seconds"]
                for row in db.execute(
                    "SELECT episode_id, position_seconds FROM podcast_progress WHERE user_id=?",
                    (user,),
                )
            }
            assert rows == {"fs-1": 420, "fs-2": 500, "etw-3": 99}
            episodes = {
                row["id"]: (row["podcast_id"], row["local_path"], row["download_status"])
                for row in db.execute("SELECT * FROM podcast_episodes")
            }
            assert episodes == {
                "fs-1": ("fireside", str(files["old-1"]), "downloaded"),
                "fs-2": ("fireside", str(files["new-2"]), "downloaded"),
                "etw-3": ("fireside", str(files["old-3"]), "downloaded"),
            }
            assert (
                db.execute(
                    "SELECT episode_id FROM podcast_resource_refs WHERE user_id=?", (user,)
                ).fetchone()[0]
                == "fs-1"
            )
        assert files["old-1"].exists() and files["old-3"].exists() and files["new-2"].exists()
        assert not files["old-2"].exists()
        after = client.get(f"{API}/duplicates").json()
        assert after["verified"] == 0
        assert client.get("/api/v1/podcasts/fireside").status_code == 200


def test_identity_endpoints_belong_to_the_owner(settings, authenticated_client, itunes, feeds):
    with authenticated_client(settings) as client:
        created = client.post(
            "/api/v1/manage/users",
            headers=HEADERS,
            json={"username": "listen", "password": "listener-password-1", "library_ids": []},
        )
        assert created.status_code == 201
        listener = search_support.TestClient(client.app)
        try:
            listener.post(
                "/api/v1/auth/login",
                headers=HEADERS,
                json={"username": "listen", "password": "listener-password-1"},
            )
            assert listener.get(f"{API}/duplicates").status_code == 403
            assert listener.get(f"{API}/backfill").status_code == 403
            assert listener.post(f"{API}/backfill", headers=HEADERS).status_code == 403
            assert (
                listener.post(
                    f"{API}/merge", headers=HEADERS, json={"keep_id": "a", "merge_id": "b"}
                ).status_code
                == 403
            )
        finally:
            listener.close()
        same = client.post(f"{API}/merge", headers=HEADERS, json={"keep_id": "a", "merge_id": "a"})
        assert same.status_code == 422
        missing = client.post(
            f"{API}/merge", headers=HEADERS, json={"keep_id": "a", "merge_id": "b"}
        )
        assert missing.status_code == 404
