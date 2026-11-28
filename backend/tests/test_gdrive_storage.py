"""Drive integration uses the real HTTP transport against a loopback fixture."""

import io
import json
import shutil
import sqlite3
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient
from gdrive_test_fixture import drive_fixture
from mutagen.flac import FLAC, Picture
from mutagen.id3 import APIC, TALB, TIT2, TPE1, TXXX
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4, MP4Cover
from PIL import Image
from test_bookshelf import sample_epub
from test_multiple_libraries import HEADERS, listener

from wildstring.database import Database
from wildstring.storage.gdrive import DriveError

DRIVE = "/api/v1/remote-storage"
AUDIO = Path(__file__).resolve().parents[2] / "tests/fixtures/audio"
SECRET = "fixture-client-secret"


def post(client, path, **body):
    return client.post(f"{DRIVE}/{path}", headers=HEADERS, json=body)


def ok(response, status=200):
    assert response.status_code == status, response.text
    return response.json()


@pytest.fixture
def cloud(settings, authenticated_client):
    with drive_fixture() as remote, authenticated_client(settings) as owner:
        storage = owner.app.state.remote_storage
        storage.accounts.drive_base = storage.accounts.oauth_base = remote.base
        yield owner, remote, storage


def account(owner, *, scope="drive_readonly"):
    return ok(
        post(
            owner,
            "accounts",
            name=scope,
            client_id="fixture-client",
            client_secret=SECRET,
            scope_mode=scope,
        ),
        201,
    )


def authorize(owner, item):
    result = ok(post(owner, "authorize", account_id=item["id"]))
    url = urlsplit(result["authorization_url"])
    assert url.netloc == "accounts.google.com"
    query = parse_qs(url.query)
    assert query["scope"] == [
        f"https://www.googleapis.com/auth/{item['scope_mode'].replace('_', '.')}"
    ]
    return query


def bind(owner, item):
    query = authorize(owner, item)
    return ok(post(owner, "finish", code="oauth-code", state=query["state"][0]))


def library(owner, item, collection, folder_id=None, **options):
    data = ok(
        post(
            owner,
            "libraries",
            account_id=item["id"],
            collection=collection,
            name=f"Drive {collection}",
            folder_id=folder_id,
            **options,
        ),
        201,
    )
    return {"collection": collection, "library_id": data["id"]}, data["remote"]


def music_headers(action):
    return HEADERS | {"X-Wildstring-Library": action["library_id"]}


def media(name, title, *, book_author=None):
    data = io.BytesIO((AUDIO / name).read_bytes())
    picture = io.BytesIO()
    Image.new("RGB", (40, 40), "#a75231").save(picture, "PNG")
    if name.endswith(".mp3"):
        audio = MP3(data)
        audio["TIT2"] = TIT2(encoding=3, text=[title])
        audio["TALB"] = TALB(encoding=3, text=[title])
        audio["TPE1"] = TPE1(encoding=3, text=["Reader"])
        if book_author:
            audio.tags.add(TXXX(encoding=3, desc="AUTHOR", text=[book_author]))
        audio["APIC:"] = APIC(
            encoding=3, mime="image/png", type=3, desc="", data=picture.getvalue()
        )
    elif name.endswith(".flac"):
        audio = FLAC(data)
        audio["title"] = title
        cover = Picture()
        cover.type, cover.mime, cover.data = 3, "image/png", picture.getvalue()
        audio.add_picture(cover)
    else:
        audio = MP4(data)
        audio["©nam"] = [title]
        audio["covr"] = [MP4Cover(picture.getvalue(), imageformat=MP4Cover.FORMAT_PNG)]
    data.seek(0)
    audio.save(data)
    return data.getvalue()


def test_session_bound_oauth_secrets_and_refresh(cloud, settings, caplog):
    owner, remote, storage = cloud
    item = account(owner)
    assert item["status"] == "auth_required"
    assert SECRET not in json.dumps(item)
    assert owner.post(f"{DRIVE}/authorize", json={"account_id": item["id"]}).status_code == 403
    query = authorize(owner, item)
    state = query["state"][0]
    assert query["redirect_uri"] == [f"http://testserver{DRIVE}/callback"]
    callback = owner.get(f"{DRIVE}/callback")
    assert callback.headers["cache-control"] == "no-store"
    assert callback.headers["referrer-policy"] == "no-referrer"
    with TestClient(owner.app) as other:
        ok(
            other.post(
                "/api/v1/auth/login",
                headers=HEADERS,
                json={
                    "username": "admin",
                    "password": "test-admin-password-123",
                },
            )
        )
        assert post(other, "finish", state=state, code="other-code").status_code == 400
    assert (
        owner.post(
            f"{DRIVE}/finish",
            headers=HEADERS | {"Host": "different.example.test"},
            json={"state": state, "code": "wrong-origin"},
        ).status_code
        == 400
    )
    assert post(owner, "finish", state=state, code="good-code").json()["status"] == "connected"
    assert post(owner, "finish", state=state, code="replay").status_code == 400
    row = storage.accounts.account(item["id"])
    paths = [storage.accounts.root / row[key] for key in ("secret_ref", "token_ref")]
    assert all(path.stat().st_mode & 0o777 == 0o600 for path in paths)
    token = storage.accounts.read_secret(row["token_ref"])
    storage.accounts.save_secret(row["token_ref"], token | {"expires_at": 0})
    ok(post(owner, "test", account_id=item["id"]))
    assert remote.tokens[-1]["grant_type"] == "refresh_token"
    assert remote.tokens[-1]["refresh_token"] == "test-refresh-token"
    database_files = list(settings.data_dir.glob("wildstring.sqlite3*"))
    assert all(SECRET.encode() not in path.read_bytes() for path in database_files)
    accounts = owner.get(f"{DRIVE}/accounts").text
    for value in (SECRET, "test-refresh-token", "test-access-1", "good-code"):
        assert value not in accounts
        assert value not in caplog.text
    assert ok(post(owner, "revoke", account_id=item["id"]))["status"] == "auth_required"
    assert not paths[1].exists()
    assert remote.requests["POST", "/revoke"] == 1


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg required to create a tail-moov M4A")
def test_music_tree_changes_cover_lyrics_and_restrictions(cloud, settings, tmp_path):
    owner, remote, _ = cloud
    item = bind(owner, account(owner))
    remote.folder("music", "Music")
    remote.folder("album", "Album", "music")
    m4a = tmp_path / "tail.m4a"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "anoisesrc=duration=30:seed=3",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            str(m4a),
        ],
        timeout=15,
        check=True,
    )
    for name, title in (
        ("playback.mp3", "Drive MP3"),
        ("lossless.flac", "Drive FLAC"),
        (str(m4a), "Drive M4A"),
    ):
        path = Path(name)
        remote.file(path.stem, path.name, "album", media(name, title))
    remote.file("lyrics", "playback.lrc", "album", b"[00:00]Drive lyric")
    action, binding = library(owner, item, "music", folder_id="music")
    assert binding["cache_max_mb"] == 2048
    result = ok(post(owner, "sync", **action))
    assert result["counts"]["added"] == 3, result
    tracks = ok(owner.get("/api/v1/tracks", headers=music_headers(action)))["items"]
    assert {track["title"] for track in tracks} == {"Drive MP3", "Drive FLAC", "Drive M4A"}
    downloads = len(remote.ranges)
    for track in tracks:
        response = owner.get(f"/api/v1/tracks/{track['id']}/cover")
        assert response.status_code == 200, response.text
    track_id = next(track["id"] for track in tracks if track["title"] == "Drive MP3")
    assert "Drive lyric" in owner.get(f"/api/v1/tracks/{track_id}/lyrics").text
    assert len(remote.ranges) == downloads
    assert all(end - start < 256 * 1024 for _, start, end in remote.ranges[:downloads])
    tail_ranges = [(start, end) for identity, start, end in remote.ranges if identity == "tail"]
    assert any(start > 256 * 1024 for start, _ in tail_ranges)
    assert sum(end - start + 1 for start, end in tail_ranges) < len(remote.content["tail"])
    uploaded = owner.post(
        "/api/v1/manage/library/upload",
        headers=music_headers(action),
        files={
            "file": ("upload.mp3", (AUDIO / "playback.mp3").read_bytes(), "audio/mpeg"),
        },
    )
    assert uploaded.status_code == 409 and uploaded.json()["detail"] == "remote_storage_read_only"
    assert remote.requests["POST", "/upload/drive/v3/files"] == 0
    reader, _ = listener(owner, [])
    with reader:
        assert reader.get(f"{DRIVE}/accounts").status_code == 403
        assert reader.get(f"/api/v1/tracks/{track_id}/stream").status_code == 404
        assert post(reader, "sync", **action).status_code == 403
    remote.remove("playback")
    remote.file("lossless", "lossless.flac", "album", media("lossless.flac", "Updated FLAC"))
    before = remote.requests["GET", "/drive/v3/files"]
    result = ok(post(owner, "sync", **action))
    assert result["counts"]["updated"] == result["counts"]["missing"] == 1
    assert remote.requests["GET", "/drive/v3/changes"] == 1
    assert remote.requests["GET", "/drive/v3/files"] == before
    assert owner.get(f"/api/v1/tracks/{track_id}/stream").status_code == 409
    remote.expired_cursor = True
    ok(post(owner, "sync", **action))
    assert remote.requests["GET", "/drive/v3/files"] > before
    assert not list((settings.data_dir / "libraries" / action["library_id"]).rglob("*.flac"))


def test_books_scan_local_chapters_autopair_and_original_ranges(cloud, settings):
    owner, remote, _ = cloud
    item = bind(owner, account(owner))
    remote.folder("books", "Books")
    remote.folder("story", "Story", "books")
    epub = sample_epub()
    remote.file("epub", "Portable.epub", "story", epub)
    audio = media("playback.mp3", "Portable EPUB", book_author="Reader")
    remote.file("part1", "01.mp3", "story", audio)
    remote.file("part2", "02.mp3", "story", audio)
    action, _ = library(owner, item, "books", folder_id="books", cache_max_mb=0)
    result = ok(post(owner, "sync", **action))
    assert result["counts"]["added"] == 3, result
    (book,) = ok(owner.get("/api/v1/books"))["items"]
    assert book["has_ebook"] and book["has_audiobook"], book
    base = f"/api/v1/books/{book['id']}"
    before = len(remote.ranges)
    assert "Visible text" in owner.get(f"{base}/ebook/chapters/0").text
    chapters = ok(owner.get(f"{base}/audiobook"))["chapters"]
    assert [chapter["file_index"] for chapter in chapters] == [0, 1]
    assert len(remote.ranges) == before
    for endpoint, payload in (
        ("ebook/download", epub),
        ("audiobook/files/1/stream", audio),
    ):
        request = owner.get(f"{base}/{endpoint}", headers={"Range": "bytes=10-30"})
        assert request.status_code == 206 and request.content == payload[10:31]
    remote.remove("part1")
    ok(post(owner, "sync", **action))
    assert len(ok(owner.get(f"{base}/audiobook"))["chapters"]) == 1
    assert owner.get(f"{base}/audiobook/files/0/stream").content == audio
    split = ok(owner.post(f"{base}/split", headers=HEADERS, json={"carrier": "audiobook"}), 201)
    split_base = f"/api/v1/books/{split['id']}"
    assert owner.get(f"{split_base}/audiobook/files/0/stream").content == audio
    ok(owner.post(f"{base}/pair", headers=HEADERS, json={"other_book_id": split["id"]}))
    assert owner.get(f"{base}/audiobook/files/0/stream").content == audio
    assert not (settings.data_dir / "remote-cache").exists()
    assert not list((settings.data_dir / "books").rglob("*.epub"))

    repair = owner.post(f"{base}/rescan", headers=HEADERS)
    assert (repair.status_code, repair.json()["detail"]) == (409, "remote_storage_local_operation")
    storage = owner.app.state.remote_storage
    with storage.db.connect(scoped=False) as sql:
        ebook_ref = sql.execute(
            "SELECT * FROM remote_media_objects WHERE entity_kind='book_ebook' AND entity_id=?",
            (book["id"],),
        ).fetchone()
    storage.cache.configure(("books", action["library_id"]), limit=1)
    with storage.cache.writer(ebook_ref) as cached:
        cached.write(epub)
    assert list(storage.cache.root.iterdir())
    deleted_book = owner.delete(base, headers=HEADERS)
    assert deleted_book.status_code == 204
    assert not list(storage.cache.root.iterdir())
    assert remote.content["epub"] == epub
    assert remote.content["part2"] == audio
    deleted_lib = owner.delete(f"/api/v1/book-libraries/{action['library_id']}", headers=HEADERS)
    assert deleted_lib.status_code == 204


def test_managed_resumable_uploads_resume_and_validate_location(cloud, settings):
    owner, remote, storage = cloud
    item = bind(owner, account(owner, scope="drive_file"))
    music, binding = library(owner, item, "music")
    books, _ = library(owner, item, "books")
    audio = media("playback.mp3", "Uploaded Track")
    result = owner.post(
        "/api/v1/manage/library/upload",
        headers=music_headers(music),
        files={
            "file": ("Upload.mp3", audio, "audio/mpeg"),
        },
        data={"relative_path": "Some Folder/Upload.mp3"},
    )
    assert ok(result)["status"] == "imported"
    lyrics = owner.post(
        "/api/v1/manage/library/upload",
        headers=music_headers(music),
        files={
            "file": ("Upload.lrc", b"[00:05]Uploaded lyrics", "text/plain"),
        },
    )
    assert ok(lyrics)["kind"] == "sidecar"
    (track,) = ok(owner.get("/api/v1/tracks", headers=music_headers(music)))["items"]
    assert "Uploaded lyrics" in owner.get(f"/api/v1/tracks/{track['id']}/lyrics").text
    epub = sample_epub()
    book = ok(
        owner.post(
            "/api/v1/books/upload",
            headers=HEADERS,
            data={"library_id": books["library_id"]},
            files={"file": ("sample.epub", epub, "application/epub+zip")},
        ),
        201,
    )
    assert owner.get(f"/api/v1/books/{book['id']}/ebook/download").content == epub
    assert not list((settings.data_dir / "libraries" / music["library_id"]).rglob("*.mp3"))
    assert not list((settings.data_dir / "books" / books["library_id"]).rglob("*.epub"))
    drive = storage.accounts.drive(item["id"])
    data = b"m" * (8 * 1024 * 1024 + 28)
    remote.upload_interrupted = True
    ref = drive.upload_stream(
        binding["root_folder_id"],
        Path("resumable.bin"),
        io.BytesIO(data),
        len(data),
        "application/octet-stream",
    )
    assert remote.content[ref.id] == data
    remote.upload_session_url = "http://127.0.0.1:1/other?upload_id=not-allowed"
    with pytest.raises(DriveError, match="remote_storage_invalid_upload_session"):
        drive.upload_stream(
            binding["root_folder_id"],
            Path("unsafe.bin"),
            io.BytesIO(b"1"),
            1,
            "application/octet-stream",
        )


def test_range_singleflight_lru_disabled_and_drive_errors(cloud):
    owner, remote, storage = cloud
    item = bind(owner, account(owner))
    remote.folder("music", "Music")
    payload = (AUDIO / "playback.mp3").read_bytes() + b"\0" * (550 * 1024)
    for identity in ("one", "two", "three"):
        remote.file(identity, f"{identity}.mp3", "music", payload)
    action, _ = library(owner, item, "music", folder_id="music", cache_max_mb=1)
    ok(post(owner, "sync", **action))
    with storage.db.connect(scoped=False) as sql:
        tracks = {
            row["remote_file_id"]: f"/api/v1/tracks/{row['entity_id']}/stream"
            for row in sql.execute("SELECT remote_file_id,entity_id FROM remote_media_objects")
        }
    one, two, three = (tracks[name] for name in ("one", "two", "three"))
    assert owner.head(one).headers["content-length"] == str(len(payload))
    assert owner.get(one, headers={"Range": "bytes=2-11"}).content == payload[2:12]
    assert remote.ranges[-1] == ("one", 2, 11)
    assert owner.get(one, headers={"Range": "bytes=999999999-"}).status_code == 416
    remote.delay = 0.15
    remote.ranges.clear()
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda _: owner.get(one).content, range(2)))
    assert results == [payload, payload]
    assert remote.ranges == [("one", 0, len(payload) - 1)]
    assert owner.get(two).content == payload
    assert storage.binding("music", action["library_id"])["cache_used_bytes"] == len(payload)
    assert owner.get(three).content == payload
    assert owner.get(one).content == payload
    assert remote.ranges.count(("one", 0, len(payload) - 1)) == 2
    assert ok(post(owner, "cache/clear", **action))["cache_used_bytes"] == 0
    ok(post(owner, "cache", **action, cache_max_mb=0))
    assert owner.get(one).content == owner.get(one).content == payload
    assert list(storage.cache.root.iterdir()) == []
    remote.rate_limit.add("two")
    limited = owner.get(two)
    assert limited.status_code == 503 and limited.json()["detail"] == "remote_storage_rate_limited"
    assert limited.headers["retry-after"] == "23"
    remote.reject.add("three")
    remote.invalid_grant = True
    auth = owner.get(three)
    assert auth.status_code == 503 and auth.json()["detail"] == "remote_storage_auth_required"
    assert storage.accounts.account(item["id"])["status"] == "auth_required"


@pytest.mark.skipif(
    not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="FFmpeg required"
)
def test_real_aac_and_temporary_m4b_chapters(cloud, tmp_path):
    owner, remote, storage = cloud
    item = bind(owner, account(owner))
    remote.folder("music", "Music")
    remote.folder("books", "Books")
    remote.file("lossless", "Audio.flac", "music", (AUDIO / "lossless.flac").read_bytes())
    music, _ = library(owner, item, "music", folder_id="music", cache_max_mb=0)
    books, _ = library(owner, item, "books", folder_id="books")
    chapters = tmp_path / "chapters.txt"
    chapters.write_text(
        ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1200\ntitle=Opening\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1200\nEND=2500\ntitle=Outro\n"
    )
    m4b = tmp_path / "Story.m4b"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(AUDIO / "playback.mp3"),
            "-i",
            str(chapters),
            "-map_metadata",
            "1",
            "-map_chapters",
            "1",
            "-t",
            "2.5",
            "-c:a",
            "aac",
            str(m4b),
        ],
        check=True,
        timeout=15,
    )
    remote.file("story", "Story.m4b", "books", m4b.read_bytes())
    ok(post(owner, "sync", **books))
    (book,) = ok(owner.get("/api/v1/books"))["items"]
    manifest = ok(owner.get(f"/api/v1/books/{book['id']}/audiobook"))
    assert [chapter["title"] for chapter in manifest["chapters"]] == ["Opening", "Outro"]
    ok(post(owner, "sync", **music))
    (track,) = ok(owner.get("/api/v1/tracks"))["items"]
    remote.ranges.clear()
    plan = ok(owner.get(f"/api/v1/tracks/{track['id']}/playback?format=aac&bitrate_kbps=128"))
    assert plan["mode"] == "transcode" and remote.ranges == []
    response = owner.get(plan["stream_url"])
    assert response.status_code == 200 and response.headers["x-wildstring-codec"] == "aac"
    assert b"ftyp" in response.content[:32]
    assert len(remote.ranges) == 1
    assert not storage.cache.root.exists()


def test_move_between_drive_libraries_marks_old_track_missing(cloud):
    owner, drive, _ = cloud
    item = bind(owner, account(owner))
    drive.folder("first", "First")
    drive.folder("second", "Second")
    audio = media("playback.mp3", "Movable")
    drive.file("movable", "Song.mp3", "first", audio)
    first, _ = library(owner, item, "music", folder_id="first")
    second, _ = library(owner, item, "music", folder_id="second")
    ok(post(owner, "sync", **first))
    ok(post(owner, "sync", **second))
    (old,) = ok(owner.get("/api/v1/tracks", headers=music_headers(first)))["items"]
    drive.file("movable", "Song.mp3", "second", audio)
    ok(post(owner, "sync", **second))
    ok(post(owner, "sync", **first))
    (new,) = ok(owner.get("/api/v1/tracks", headers=music_headers(second)))["items"]
    assert new["id"] != old["id"]
    assert owner.get(f"/api/v1/tracks/{old['id']}/stream").status_code == 409
    assert owner.get(f"/api/v1/tracks/{new['id']}/stream").content == audio


def test_actual_v63_migration_preserves_local_modes(settings):
    db = Database(settings.data_dir)
    db.initialize()
    with sqlite3.connect(db.path) as sql:
        for table in (
            "remote_oauth_states",
            "remote_drive_tree",
            "remote_media_cache",
            "remote_media_objects",
            "library_remote_storage",
            "remote_storage_accounts",
        ):
            sql.execute(f"DROP TABLE {table}")
        sql.execute("ALTER TABLE libraries DROP COLUMN storage_backend")
        sql.execute("ALTER TABLE book_libraries DROP COLUMN storage_backend")
        sql.execute("ALTER TABLE track_lyrics DROP COLUMN remote_text")
        sql.execute(
            "INSERT INTO libraries(id,root,storage_mode) VALUES ('v63','/legacy','hardlink')"
        )
        sql.execute("""INSERT INTO book_libraries(id,name,managed_root,created_at,updated_at)
                       VALUES ('v63','old','/old-books',0,0)""")
        sql.execute("PRAGMA user_version=63")
    db.initialize()
    with db.connect(scoped=False) as sql:
        assert sql.execute("PRAGMA user_version").fetchone()[0] == 64
        assert tuple(
            sql.execute(
                "SELECT storage_mode,storage_backend FROM libraries WHERE id='v63'"
            ).fetchone()
        ) == ("hardlink", "local")
        assert tuple(
            sql.execute(
                "SELECT storage_mode,storage_backend FROM book_libraries WHERE id='v63'"
            ).fetchone()
        ) == ("copy", "local")
        assert not sql.execute("PRAGMA foreign_key_check").fetchall()


def test_review_regressions_unreadable_root_cache_replacement_and_mismatch(cloud):
    owner, remote, storage = cloud
    # Exempt from music-library header filtering so Drive admin works regardless of selection.
    assert (
        owner.get(
            f"{DRIVE}/accounts",
            headers={"X-Wildstring-Library": "nonexistent-library-id"},
        ).status_code
        == 200
    )

    # Under drive.file, newly created top-level folders have an opaque My Drive root parent
    # that is not readable via files.get (404). Creating a second library must still succeed,
    # while binding a nested subfolder or the same folder must be rejected with 409.
    item = bind(owner, account(owner, scope="drive_file"))
    remote.folder("managed-a", "Managed A", parent="opaque-my-drive-root")
    remote.folder("managed-b", "Managed B", parent="opaque-my-drive-root")
    remote.folder("nested-under-a", "Nested", parent="managed-a")
    lib_a, _ = library(owner, item, "music", folder_id="managed-a", cache_max_mb=4)
    lib_b, _ = library(owner, item, "music", folder_id="managed-b", cache_max_mb=4)
    assert lib_a["library_id"] != lib_b["library_id"]
    dup = post(
        owner,
        "libraries",
        account_id=item["id"],
        collection="music",
        name="Overlap Nested",
        folder_id="nested-under-a",
    )
    assert dup.status_code == 409 and dup.json()["detail"] == "remote_storage_folder_already_bound"

    # Replacing a modified Drive file must unlink the superseded cache file rather than leaking it.
    v1 = media("playback.mp3", "Version 1")
    v2 = media("playback.mp3", "Version 2")
    remote.file("evolving", "Song.mp3", "managed-a", v1)
    ok(post(owner, "sync", **lib_a))
    (track,) = ok(owner.get("/api/v1/tracks", headers=music_headers(lib_a)))["items"]
    assert owner.get(f"/api/v1/tracks/{track['id']}/stream").content == v1
    before_files = list(storage.cache.root.iterdir())
    assert len(before_files) == 1
    remote.file("evolving", "Song.mp3", "managed-a", v2)
    ok(post(owner, "sync", **lib_a))
    assert owner.get(f"/api/v1/tracks/{track['id']}/stream").content == v2
    after_files = list(storage.cache.root.iterdir())
    assert len(after_files) == 1 and after_files != before_files

    # Reconnecting with a different Google account permissionId must be rejected with 409.
    remote.subject = "different-google-user"
    query = authorize(owner, item)
    mismatch = post(owner, "finish", state=query["state"][0], code="other-user-code")
    assert (
        mismatch.status_code == 409
        and mismatch.json()["detail"] == "remote_storage_account_mismatch"
    )
