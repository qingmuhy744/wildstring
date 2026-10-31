"""Backfilling directory ids for old rows never trusts titles, and merges only verified rows."""

import sqlite3
import threading
import time
from contextlib import closing
from datetime import UTC, datetime, timedelta

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
            f"{API}/merge", headers=HEADERS, json={"podcast_ids": ["fireside", "etw"]}
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
            f"{API}/merge", headers=HEADERS, json={"podcast_ids": ["fireside", "etw"]}
        )
        assert (busy.status_code, busy.json()["detail"]) == (409, "podcast_merge_busy")
        with connect(settings) as db:
            db.execute("UPDATE podcast_episodes SET download_status='none' WHERE id='fs-1'")
            db.commit()

        merged = client.post(
            f"{API}/merge", headers=HEADERS, json={"podcast_ids": ["fireside", "etw"]}
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


def test_identity_endpoints_refuse_listeners(settings, authenticated_client, itunes, feeds):
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
                    f"{API}/merge", headers=HEADERS, json={"podcast_ids": ["a", "b"]}
                ).status_code
                == 403
            )
        finally:
            listener.close()
        same = client.post(f"{API}/merge", headers=HEADERS, json={"podcast_ids": ["a", "a"]})
        assert same.status_code == 422
        missing = client.post(f"{API}/merge", headers=HEADERS, json={"podcast_ids": ["a", "b"]})
        assert missing.status_code == 404


def login_as(client, username, profile):
    created = client.post(
        "/api/v1/manage/users",
        headers=HEADERS,
        json={
            "username": username,
            "password": f"{username}-password-1",
            "profile": profile,
            "library_ids": [],
        },
    )
    assert created.status_code == 201, created.text
    other = search_support.TestClient(client.app)
    assert (
        other.post(
            "/api/v1/auth/login",
            headers=HEADERS,
            json={"username": username, "password": f"{username}-password-1"},
        ).status_code
        == 200
    )
    return other


def test_library_admins_backfill_list_and_merge_but_editors_cannot(
    settings, authenticated_client, itunes, feeds
):
    with authenticated_client(settings) as client:
        seed_duplicates(settings, settings.podcasts_dir)
        librarian = login_as(client, "curator", "librarian")
        editor = login_as(client, "editor", "editor")
        try:
            for path in ("backfill", "duplicates"):
                assert editor.get(f"{API}/{path}").status_code == 403
            assert editor.post(f"{API}/backfill", headers=HEADERS).status_code == 403
            assert (
                editor.post(
                    f"{API}/merge", headers=HEADERS, json={"podcast_ids": ["etw", "fireside"]}
                ).status_code
                == 403
            )

            assert librarian.get(f"{API}/duplicates").json()["possible"] == 2
            run_backfill(librarian)
            assert librarian.get(f"{API}/duplicates").json()["verified"] == 1
            merged = librarian.post(
                f"{API}/merge", headers=HEADERS, json={"podcast_ids": ["etw", "fireside"]}
            )
            assert merged.status_code == 200, merged.text
            assert (merged.json()["kept_id"], merged.json()["merged_id"]) == ("fireside", "etw")
        finally:
            librarian.close()
            editor.close()


def verified_pair(db, *, a_redirects, b_redirects, a_followers, b_followers):
    """Two rows sharing a verified id; ``*_redirects`` sets a resolved feed elsewhere."""
    users = [admin_id(db)]
    for index in range(max(a_followers, b_followers)):
        user = f"listener-{index}"
        db.execute(
            "INSERT INTO users(id,username,password_hash,profile,enabled) "
            "VALUES (?,?,NULL,'listener',1)",
            (user, user),
        )
        users.append(user)
    for podcast_id, redirects, followers, created in (
        ("a", a_redirects, a_followers, "2024-01-01"),
        ("b", b_redirects, b_followers, "2025-01-01"),
    ):
        feed = f"https://{podcast_id}.example.com/rss"
        legacy_show(db, podcast_id, "同一节目", feed, created=created)
        db.execute(
            "UPDATE podcasts SET itunes_id='42', itunes_check_status='matched', "
            "feed_url_normalized=?, resolved_feed_url_normalized=? WHERE id=?",
            (
                f"{podcast_id}.example.com/rss",
                "final.example.com/rss" if redirects else f"{podcast_id}.example.com/rss",
                podcast_id,
            ),
        )
        episode(db, f"{podcast_id}-1", podcast_id, f"{podcast_id}-only")
        for user in users[:followers]:
            db.execute(
                "INSERT INTO podcast_follows(user_id,podcast_id) VALUES (?,?)", (user, podcast_id)
            )


@pytest.mark.parametrize(
    ("a_redirects", "b_redirects", "a_followers", "b_followers", "kept"),
    [
        # The show whose own URL is final wins, even with fewer followers.
        (True, False, 3, 1, "b"),
        (False, True, 1, 3, "a"),
        # Both final, or both redirecting: more followers wins.
        (False, False, 1, 2, "b"),
        (True, True, 2, 1, "a"),
    ],
)
def test_merge_keeps_the_final_feed_then_the_most_followed_show(
    settings, authenticated_client, a_redirects, b_redirects, a_followers, b_followers, kept
):
    with authenticated_client(settings) as client:
        with connect(settings) as db:
            verified_pair(
                db,
                a_redirects=a_redirects,
                b_redirects=b_redirects,
                a_followers=a_followers,
                b_followers=b_followers,
            )
            db.commit()
        report = client.get(f"{API}/duplicates").json()
        assert [d["suggested_keep_id"] for d in report["duplicates"]] == [kept]
        gone = "a" if kept == "b" else "b"
        # The order the client names the pair in does not decide the keeper.
        merged = client.post(f"{API}/merge", headers=HEADERS, json={"podcast_ids": [kept, gone]})
        assert merged.status_code == 200, merged.text
        assert (merged.json()["kept_id"], merged.json()["merged_id"]) == (kept, gone)
        assert merged.json()["episodes_moved"] == 1
        with connect(settings) as db:
            assert [r[0] for r in db.execute("SELECT id FROM podcasts")] == [kept]
            assert {r[0] for r in db.execute("SELECT podcast_id FROM podcast_episodes")} == {kept}
            followers = db.execute(
                "SELECT COUNT(DISTINCT user_id), COUNT(*) FROM podcast_follows WHERE podcast_id=?",
                (kept,),
            ).fetchone()
            assert followers[0] == followers[1] == max(a_followers, b_followers)


def test_merge_ignores_the_order_the_pair_is_named_in(settings, authenticated_client):
    with authenticated_client(settings) as client:
        with connect(settings) as db:
            verified_pair(db, a_redirects=True, b_redirects=False, a_followers=2, b_followers=0)
            db.commit()
        merged = client.post(f"{API}/merge", headers=HEADERS, json={"podcast_ids": ["a", "b"]})
        assert (merged.json()["kept_id"], merged.json()["merged_id"]) == ("b", "a")
        with connect(settings) as db:
            assert (
                db.execute("SELECT COUNT(*) FROM podcast_follows WHERE podcast_id='b'").fetchone()[
                    0
                ]
                == 2
            )


def test_no_match_rows_are_rechecked_only_after_seven_days(settings):
    database = Database(settings.data_dir)
    database.initialize()
    recent = datetime.now(UTC) - timedelta(days=6)
    stale = datetime.now(UTC) - timedelta(days=8)
    with connect(settings) as db:
        for podcast_id, status, checked in (
            ("fresh", None, None),
            ("failed", "failed", recent),
            ("recent", "no_match", recent),
            ("stale", "no_match", stale),
            ("unknown", "no_match", None),
        ):
            legacy_show(db, podcast_id, podcast_id, f"https://{podcast_id}.example.com/rss")
            db.execute(
                "UPDATE podcasts SET itunes_check_status=?, itunes_checked_at=? WHERE id=?",
                (status, checked.isoformat() if checked else None, podcast_id),
            )
        legacy_show(db, "has-id", "has-id", "https://has-id.example.com/rss")
        db.execute(
            "UPDATE podcasts SET itunes_id='7', itunes_check_status='existing' WHERE id='has-id'"
        )
        db.commit()
    backfill = podcast_identity_backfill.IdentityBackfill(
        type("Manager", (), {"database": database})(), None
    )
    due = {row["id"] for row in backfill.candidates(100, False)}
    assert due == {"fresh", "failed", "stale", "unknown"}
    assert {row["id"] for row in backfill.candidates(100, True)} == due | {"recent"}


def test_startup_backfill_fills_ids_once_and_never_merges(
    settings, authenticated_client, itunes, feeds
):
    with authenticated_client(settings) as client:
        seed_duplicates(settings, settings.podcasts_dir)
        backfill = client.app.state.podcasts.identity_backfill
        assert backfill.auto_thread is None  # the test environment never schedules it
        backfill.schedule_auto(0).join(5)
        deadline = time.monotonic() + 10
        while backfill.status()["running"] or backfill.status()["last_run"] is None:
            assert time.monotonic() < deadline
            time.sleep(0.02)
        status = client.get(f"{API}/backfill").json()
        assert status["last_run"]["trigger"] == "auto"
        assert status["last_run"]["matched"] == 2
        assert status["last_run"]["duplicates"] == {"verified": 1, "possible": 1}
        rows = statuses(settings)
        assert set(rows) == {"etw", "fireside", "w1", "w2"}  # nothing merged
        assert rows["etw"]["itunes_id"] == rows["fireside"]["itunes_id"] == SHENGDONG
        assert rows["w1"]["itunes_check_status"] == "no_match"
        verified = [
            d
            for d in client.get(f"{API}/duplicates").json()["duplicates"]
            if d["confidence"] == "verified"
        ]
        assert [d["suggested_keep_id"] for d in verified] == ["fireside"]

        # A restart finds nothing left to do and spends no Apple calls.
        calls = len(itunes.calls)
        backfill.schedule_auto(0).join(5)
        assert len(itunes.calls) == calls
        assert client.get(f"{API}/backfill").json()["last_run"]["trigger"] == "auto"
        assert statuses(settings) == rows


def test_startup_backfill_waits_and_stops_with_the_server(settings):
    database = Database(settings.data_dir)
    database.initialize()
    with connect(settings) as db:
        legacy_show(db, "fireside", "声东击西", FIRESIDE)
        db.commit()
    manager = type("Manager", (), {"database": database, "stopping": threading.Event()})()
    backfill = podcast_identity_backfill.IdentityBackfill(manager, None)
    started = []
    backfill.start = lambda *args, **kwargs: started.append((args, kwargs))
    thread = backfill.schedule_auto(30)
    assert thread.is_alive() and started == []
    manager.stopping.set()
    thread.join(2)
    assert not thread.is_alive() and started == []

    manager.stopping.clear()
    backfill.schedule_auto(0).join(2)
    assert started == [((podcast_identity_backfill.MAX_BATCH, False), {"trigger": "auto"})]


def test_settings_switch_the_startup_backfill(settings, monkeypatch, tmp_path):
    from wildstring.config import Settings
    from wildstring.main import create_app

    assert settings.podcast_identity_auto_backfill is False
    monkeypatch.delenv("WILDSTRING_PODCAST_IDENTITY_AUTO_BACKFILL", raising=False)
    production = Settings(
        _env_file=None,
        environment="production",
        data_dir=tmp_path / "prod-data",
        music_dir=tmp_path / "source",
        library_dir=tmp_path / "prod-music",
    )
    assert production.podcast_identity_auto_backfill is True
    assert production.podcast_identity_auto_backfill_delay_seconds == 180
    monkeypatch.setenv("WILDSTRING_PODCAST_IDENTITY_AUTO_BACKFILL", "false")
    assert (
        Settings(_env_file=None, environment="production").podcast_identity_auto_backfill is False
    )

    scheduled = []
    monkeypatch.setattr(
        podcast_identity_backfill.IdentityBackfill,
        "schedule_auto",
        lambda self, delay, *a: scheduled.append(delay),
    )
    with search_support.TestClient(create_app(settings)):
        pass
    assert scheduled == []
    enabled = settings.model_copy(
        update={
            "podcast_identity_auto_backfill": True,
            "podcast_identity_auto_backfill_delay_seconds": 5,
        }
    )
    with search_support.TestClient(create_app(enabled)):
        pass
    assert scheduled == [5]
