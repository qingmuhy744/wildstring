"""End-to-end verification for v58 music .wildstring/ portable sidecar deepening."""

import hashlib
import io
import json
import os
import shutil
import time
from pathlib import Path
from uuid import uuid4

from mutagen.flac import FLAC
from PIL import Image
from test_personal_library import HEADERS, music
from test_providers import RECORDING, enable

from wildstring.database import SCHEMA_VERSION, Database
from wildstring.library.scanner import scan_library
from wildstring.library.sidecar import LYRIC_BUNDLE, album_folder, export_music
from wildstring.source_models import LyricChoice


def _solid_image(rgb: tuple[int, int, int], fmt: str = "PNG") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), color=rgb).save(buf, format=fmt)
    return buf.getvalue()


def _wipe_database(data_dir: Path) -> None:
    db_path = data_dir / "wildstring.sqlite3"
    for suffix in ("", "-wal", "-shm"):
        candidate = Path(str(db_path) + suffix)
        candidate.unlink(missing_ok=True)


def test_rich_multilayer_word_lyrics_survive_db_wipe_and_reset_cleanup(
    settings, authenticated_client
):
    audio_path = music(settings, "Artist/Album/01.flac", ["Artist"], ["Artist"], album="Album")
    audio_sha = hashlib.sha256(audio_path.read_bytes()).hexdigest()
    scan_library(settings)

    normalized_candidate = {
        "kind": "synced",
        "format": "word",
        "lines": [
            {
                "time_ms": 1000,
                "end_ms": 2500,
                "text": "第一句原文",
                "words": [
                    {"text": "第一句", "start_ms": 1000, "end_ms": 1800},
                    {"text": "原文", "start_ms": 1800, "end_ms": 2500},
                ],
            }
        ],
        "layers": {
            "translation": [{"time_ms": 1000, "end_ms": 2500, "text": "First line translation"}],
            "romanization": [{"time_ms": 1000, "end_ms": 2500, "text": "Di yi ju yuan wen"}],
        },
    }

    with authenticated_client(settings) as client:
        track = client.get("/api/v1/tracks").json()["items"][0]
        record = client.get(f"/api/v1/manage/tracks/{track['id']}/lyrics").json()
        job_id = uuid4().hex
        cand_id = uuid4().hex
        now_ts = time.time()
        database = Database(settings.data_dir)
        with database.connect(write=True) as db:
            db.execute(
                "INSERT INTO lyric_lookup_jobs VALUES (?,?,?,?,?,?,?,?)",
                (job_id, track["id"], "done", None, "[]", now_ts, now_ts, None),
            )
            db.execute(
                "INSERT INTO lyric_candidates VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    cand_id,
                    job_id,
                    track["id"],
                    "fixture-plugin",
                    "cand-1",
                    "https://example.test/lyrics/1",
                    json.dumps({"score": 100, "version_mismatch": False}),
                    json.dumps({"original": "[00:01.000]第一句原文"}),
                    json.dumps(normalized_candidate, ensure_ascii=False),
                    record["version"],
                    record["file_version"],
                    now_ts,
                ),
            )
        applied = client.app.state.providers.sources.apply(
            cand_id,
            LyricChoice(
                version=record["version"], file_version=record["file_version"], offset_ms=500
            ),
        )
        assert applied["effective"]["lines"][0]["time_ms"] == 1500
        assert applied["effective"]["lines"][0]["words"][0]["start_ms"] == 1500

    sidecar_dir = settings.library_dir / "Artist/Album/.wildstring"
    lrc_file = sidecar_dir / "lyrics" / f"{audio_sha}.lrc"
    bundle_file = sidecar_dir / "lyrics" / f"{audio_sha}.json"
    assert lrc_file.is_file()
    assert bundle_file.is_file()
    bundle_raw = bundle_file.read_text(encoding="utf-8")
    bundle_data = json.loads(bundle_raw)
    assert bundle_data["schema"] == LYRIC_BUNDLE
    assert str(settings.data_dir) not in bundle_raw
    assert str(settings.library_dir) not in bundle_raw
    manifest_data = json.loads((sidecar_dir / "manifest.json").read_text(encoding="utf-8"))
    assert manifest_data["tracks"][0]["lyric_bundle_file"] == f"lyrics/{audio_sha}.json"

    _wipe_database(settings.data_dir)
    Database(settings.data_dir).initialize()
    scan_library(settings)

    with authenticated_client(settings) as rebuilt:
        new_track = rebuilt.get("/api/v1/tracks").json()["items"][0]
        public_lyrics = rebuilt.get(f"/api/v1/tracks/{new_track['id']}/lyrics").json()
        assert public_lyrics["kind"] == "synced"
        assert public_lyrics["lines"][0]["time_ms"] == 1500
        assert public_lyrics["lines"][0]["end_ms"] == 3000
        assert public_lyrics["lines"][0]["words"][0]["start_ms"] == 1500
        assert public_lyrics["lines"][0]["translation"] == "First line translation"
        assert public_lyrics["lines"][0]["romanization"] == "Di yi ju yuan wen"

        editor_rec = rebuilt.get(f"/api/v1/manage/tracks/{new_track['id']}/lyrics").json()
        assert editor_rec["effective"]["lines"][0]["translation"] == "First line translation"
        assert editor_rec["effective"]["lines"][0]["words"][1]["end_ms"] == 3000

        reset_res = rebuilt.put(
            f"/api/v1/manage/tracks/{new_track['id']}/lyrics",
            headers=HEADERS,
            json={
                "version": editor_rec["version"],
                "file_version": editor_rec["file_version"],
                "text": None,
            },
        )
        assert reset_res.status_code == 200
        assert not lrc_file.exists()
        assert not bundle_file.exists()
        after_manifest = json.loads((sidecar_dir / "manifest.json").read_text(encoding="utf-8"))
        assert "lyric_file" not in after_manifest["tracks"][0]
        assert "lyric_bundle_file" not in after_manifest["tracks"][0]


def test_cover_dedup_per_track_sidecar_and_delete_cleanup(settings, authenticated_client):
    t1_path = music(
        settings, "Artist/Album/01.flac", ["Artist"], ["Artist"], album="Album", number=1
    )
    t2_path = music(
        settings, "Artist/Album/02.flac", ["Artist"], ["Artist"], album="Album", number=2
    )
    t2_sha = hashlib.sha256(t2_path.read_bytes()).hexdigest()
    scan_library(settings)
    album_dir = settings.library_dir / "Artist/Album"

    with authenticated_client(settings) as client:
        album_id = client.get("/api/v1/albums").json()["items"][0]["id"]
        tracks = {
            item["track_number"]: item for item in client.get("/api/v1/tracks").json()["items"]
        }
        red_bytes = _solid_image((220, 30, 30), "PNG")
        upload_res = client.post(
            f"/api/v1/manage/albums/{album_id}/cover",
            headers=HEADERS,
            files={"file": ("album.png", red_bytes, "image/png")},
            data={"save_sidecar": "false"},
        )
        assert upload_res.status_code == 200
        assert (album_dir / ".wildstring/cover.jpg").is_file()
        assert not (album_dir / "cover.jpg").exists()
        artwork_dir = settings.data_dir / "artwork"
        assert not (artwork_dir.exists() and any(artwork_dir.iterdir()))

        cover_resp = client.get(f"/api/v1/tracks/{tracks[1]['id']}/cover")
        assert cover_resp.status_code == 200
        assert cover_resp.headers["x-wildstring-cover-source"] == "chosen"

        # Apply a distinct green cover to track 2 only.
        providers = client.app.state.providers
        providers.stop()
        assert enable(client).status_code == 200
        url = f"https://coverartarchive.org/release/{RECORDING}/67890.jpg"
        providers.suggestions = lambda _, **_kwargs: (
            [
                (
                    "musicbrainz",
                    f"https://musicbrainz.org/recording/{RECORDING}",
                    {"title": "曲二标题"},
                    url,
                    {},
                )
            ],
            [],
        )
        providers.enqueue([tracks[2]["id"]])
        providers.step()
        candidate = client.get(f"/api/v1/manage/providers/tracks/{tracks[2]['id']}").json()[
            "suggestions"
        ][0]
        providers.request = lambda *_args, **_kwargs: _solid_image((30, 210, 40), "JPEG")
        assert (
            client.post(
                f"/api/v1/manage/providers/suggestions/{candidate['id']}/cover",
                headers=HEADERS,
                json={"version": candidate["metadata_version"]},
            ).status_code
            == 200
        )

    assert (album_dir / ".wildstring/covers" / f"{t2_sha}.jpg").is_file()

    # Rebuild completely without runtime artwork or thumbnail caches.
    _wipe_database(settings.data_dir)
    shutil.rmtree(settings.data_dir / "artwork", ignore_errors=True)
    shutil.rmtree(settings.data_dir / "covers", ignore_errors=True)
    Database(settings.data_dir).initialize()
    scan_library(settings)

    with authenticated_client(settings) as rebuilt:
        tracks_rebuilt = {
            item["track_number"]: item for item in rebuilt.get("/api/v1/tracks").json()["items"]
        }
        assert tracks_rebuilt[1]["has_cover"] and tracks_rebuilt[2]["has_cover"]
        c1 = rebuilt.get(f"/api/v1/tracks/{tracks_rebuilt[1]['id']}/cover").content
        c2 = rebuilt.get(f"/api/v1/tracks/{tracks_rebuilt[2]['id']}/cover").content
        p1 = Image.open(io.BytesIO(c1)).convert("RGB").getpixel((32, 32))
        p2 = Image.open(io.BytesIO(c2)).convert("RGB").getpixel((32, 32))
        assert p1[0] > p1[1] + 50
        assert p2[1] > p2[0] + 50

        rebuilt_album_id = rebuilt.get("/api/v1/albums").json()["items"][0]["id"]
        del_res = rebuilt.delete(f"/api/v1/manage/albums/{rebuilt_album_id}/cover", headers=HEADERS)
        assert del_res.status_code == 200
        assert not (album_dir / ".wildstring/cover.jpg").exists()
        assert not (album_dir / ".wildstring/covers" / f"{t2_sha}.jpg").exists()
        after_tracks = rebuilt.get("/api/v1/tracks").json()["items"]
        assert all(not item["has_cover"] for item in after_tracks)
    assert t1_path.is_file()


def test_incremental_scan_detects_external_sidecar_changes_and_preserves_locks(
    settings, authenticated_client
):
    p1 = music(settings, "Artist/Album/01.flac", ["Artist"], ["Artist"], album="Album", number=1)
    p2 = music(settings, "Artist/Album/02.flac", ["Artist"], ["Artist"], album="Album", number=2)
    scan_library(settings, full=False)
    database = Database(settings.data_dir)
    with database.connect() as db:
        lib_id = db.execute("SELECT id FROM libraries").fetchone()[0]
    export_music(database, settings.library_dir, lib_id)

    before_stats = (
        p1.stat().st_mtime_ns,
        p1.stat().st_size,
        p2.stat().st_mtime_ns,
        p2.stat().st_size,
    )
    with database.connect(write=True) as db:
        t1_id = db.execute("SELECT id FROM tracks WHERE path='Artist/Album/01.flac'").fetchone()[0]
        t2_id = db.execute("SELECT id FROM tracks WHERE path='Artist/Album/02.flac'").fetchone()[0]
        t1_sha = db.execute("SELECT sha256 FROM tracks WHERE id=?", (t1_id,)).fetchone()[0]
        t2_sha = db.execute("SELECT sha256 FROM tracks WHERE id=?", (t2_id,)).fetchone()[0]
        db.execute(
            "UPDATE track_metadata SET overrides=? WHERE track_id=?",
            (json.dumps({"title": "本地锁定歌名"}, ensure_ascii=False), t1_id),
        )
        db.execute(
            "INSERT INTO track_lyrics(track_id,text) VALUES (?,'[00:01.000]本地锁定歌词')",
            (t1_id,),
        )
        db.execute("INSERT INTO lyric_locks(track_id,locked,version) VALUES (?,1,1)", (t1_id,))

    sidecar_dir = settings.library_dir / "Artist/Album/.wildstring"
    (sidecar_dir / "lyrics").mkdir(exist_ok=True)
    (sidecar_dir / "lyrics" / f"{t1_sha}.lrc").write_text("[00:02.000]外部歌词一", encoding="utf-8")
    (sidecar_dir / "lyrics" / f"{t2_sha}.lrc").write_text("[00:02.000]外部歌词二", encoding="utf-8")
    cover_bytes = _solid_image((40, 90, 210), "JPEG")
    (sidecar_dir / "cover.jpg").write_bytes(cover_bytes)
    manifest = json.loads((sidecar_dir / "manifest.json").read_text(encoding="utf-8"))
    for entry in manifest["tracks"]:
        entry["title"] = "侧车新标题"
        entry["genres"] = ["Ambient"]
        entry["locked_fields"] = ["title", "genres"]
        entry["lyric_file"] = f"lyrics/{entry['sha256']}.lrc"
    manifest["cover_file"] = "cover.jpg"
    manifest["cover_sha256"] = hashlib.sha256(cover_bytes).hexdigest()
    (sidecar_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
    )

    # Incremental scan without touching audio mtime/size picks up sidecar changes.
    scan_library(settings, full=False)
    assert (
        p1.stat().st_mtime_ns,
        p1.stat().st_size,
        p2.stat().st_mtime_ns,
        p2.stat().st_size,
    ) == before_stats

    with authenticated_client(settings) as client:
        tracks = {
            item["track_number"]: item for item in client.get("/api/v1/tracks").json()["items"]
        }
        assert tracks[1]["title"] == "本地锁定歌名"
        assert tracks[1]["genres"] == ["Ambient"]
        assert tracks[2]["title"] == "侧车新标题"
        assert tracks[2]["genres"] == ["Ambient"]
        assert tracks[1]["has_cover"] and tracks[2]["has_cover"]
        assert client.get(f"/api/v1/tracks/{tracks[1]['id']}/cover").status_code == 200
        assert (
            client.get(f"/api/v1/tracks/{tracks[1]['id']}/lyrics").json()["lines"][0]["text"]
            == "本地锁定歌词"
        )
        assert (
            client.get(f"/api/v1/tracks/{tracks[2]['id']}/lyrics").json()["lines"][0]["text"]
            == "外部歌词二"
        )

    # Externally deleting .wildstring/ cleans state and sidecar cover on incremental scan.
    shutil.rmtree(sidecar_dir)
    scan_library(settings, full=False)
    with database.connect() as db:
        assert db.execute("SELECT count(*) FROM music_sidecar_states").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM artwork_choices").fetchone()[0] == 0
    with authenticated_client(settings) as client:
        assert all(not item["has_cover"] for item in client.get("/api/v1/tracks").json()["items"])


def test_tracks_sha256_cache_avoids_rehashing_until_audio_changes(
    settings, authenticated_client, monkeypatch
):
    import wildstring.library.sidecar as sidecar_mod

    path = music(settings, "Unsorted/track.flac", ["Solo Artist"], ["Solo Artist"], album="Debut")
    scan_library(settings)
    database = Database(settings.data_dir)
    expected_sha = hashlib.sha256(path.read_bytes()).hexdigest()

    with database.connect() as db:
        lib_id = db.execute("SELECT id FROM libraries").fetchone()[0]
    export_music(database, settings.library_dir, lib_id)

    with database.connect() as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        cached = db.execute("SELECT id, sha256 FROM tracks").fetchone()
    assert cached["sha256"] == expected_sha
    track_id = cached["id"]

    with authenticated_client(settings) as client:
        # Ensure metadata update + file reorganize reuse cached tracks.sha256 with zero digest() calls.
        monkeypatch.setattr(
            sidecar_mod,
            "digest",
            lambda *_a, **_kw: (_ for _ in ()).throw(AssertionError("unexpected audio re-hash")),
        )
        meta = client.get(f"/api/v1/manage/tracks/{track_id}/metadata").json()
        put_res = client.put(
            f"/api/v1/manage/tracks/{track_id}/metadata",
            headers=HEADERS,
            json={"version": meta["version"], "overrides": {"title": "重命名单曲"}},
        )
        assert put_res.status_code == 200
        reorg_res = client.post(
            f"/api/v1/manage/tracks/{track_id}/reorganize-file", headers=HEADERS
        )
        assert reorg_res.status_code == 200 and reorg_res.json()["changed"] is True
        new_rel = Path(reorg_res.json()["new_path"])
        new_folder = album_folder(new_rel)
        assert (settings.library_dir / new_folder / ".wildstring/manifest.json").is_file()

    # Modifying the managed audio file invalidates cache and computes new hash cleanly.
    monkeypatch.undo()
    reorg_path = settings.library_dir / new_rel
    tags = FLAC(reorg_path)
    tags["comment"] = "audio-changed"
    tags.save()
    os.utime(reorg_path, None)
    updated_sha = hashlib.sha256(reorg_path.read_bytes()).hexdigest()
    assert updated_sha != expected_sha

    scan_library(settings, full=False)
    export_music(database, settings.library_dir, lib_id)
    with database.connect() as db:
        assert (
            db.execute("SELECT sha256 FROM tracks WHERE id=?", (track_id,)).fetchone()[0]
            == updated_sha
        )
