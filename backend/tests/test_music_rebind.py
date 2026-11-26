"""Review and apply music source changes without replacing track identities."""

import hashlib
import json
import shutil
import subprocess
import time

import pytest
from mutagen.flac import FLAC
from test_importer import FIXTURES, source
from test_multiple_libraries import HEADERS, listener
from test_music_sidecar import _solid_image

from wildstring.database import Database
from wildstring.library import import_files, rebind, storage
from wildstring.library.importer import import_music
from wildstring.library.rebind import MusicRebind
from wildstring.library.scope import library_context
from wildstring.library.sidecar import export_music
from wildstring.library.storage import LibraryStorage


def start_library(settings, client, source_root, managed_root):
    created = client.post(
        "/api/v1/libraries",
        headers=HEADERS,
        json={
            "name": "Rebind",
            "source_roots": [str(source_root)],
            "paused_source_roots": [str(source_root)],
            "managed_root": str(managed_root),
            "storage_mode": "copy",
        },
    )
    assert created.status_code == 201, created.text
    library = created.json()
    with library_context("admin", library["id"]):
        assert import_music(settings)["status"] == "completed"
    return library


def tracks_in(settings, library):
    with Database(settings.data_dir).connect(scoped=False) as db:
        return {
            row["title"]: dict(row)
            for row in db.execute(
                "SELECT id,title,path,sha256 FROM tracks WHERE library_id=?", (library["id"],)
            )
        }


def wait_job(client, library, job_id):
    url = f"/api/v1/libraries/{library['id']}/migrations"
    for _ in range(180):
        job = next(item for item in client.get(url).json()["items"] if item["id"] == job_id)
        if job["status"] in {"completed", "failed"}:
            return job
        time.sleep(0.05)
    raise AssertionError("Migration did not finish")


def approve(item):
    return {key: item[key] for key in ("track_id", "source_id", "source_path", "token")}


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="FLAC PCM equality needs FFmpeg")
def test_equivalent_flac_keeps_existing_overrides_without_new_changes(
    settings, authenticated_client, tmp_path
):
    incoming = tmp_path / "incoming"
    incoming.mkdir()
    original = source(settings, "one.flac", "Source title").rename(incoming / "one.flac")
    managed = tmp_path / "managed"
    with authenticated_client(settings) as client:
        library = start_library(settings, client, incoming, managed)
        track = tracks_in(settings, library)["Source title"]
        headers = HEADERS | {"X-Wildstring-Library": library["id"]}
        metadata = f"/api/v1/manage/tracks/{track['id']}/metadata"
        initial = client.get(metadata, headers=headers).json()
        overrides = {"album": None, "title": "Custom title"}
        edited = client.put(
            metadata, headers=headers, json={"version": initial["version"], "overrides": overrides}
        )
        assert edited.status_code == 200, edited.text

        reencoded = tmp_path / "reencoded.flac"
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                str(original),
                "-compression_level",
                "0",
                str(reencoded),
            ],
            check=True,
        )
        tags = FLAC(reencoded)
        tags.tags.clear()
        tags.tags.update(FLAC(original).tags)
        tags.save()
        assert reencoded.read_bytes() != original.read_bytes()
        reencoded.replace(original)

        endpoint = f"/api/v1/libraries/{library['id']}/rebind"
        base = {"version": library["version"], "target_storage_mode": "hardlink"}
        preview = client.post(endpoint + "/preview", headers=HEADERS, json=base)
        assert preview.status_code == 200, preview.text
        (item,) = preview.json()["items"]
        assert item["action"] == "equivalent", item
        assert item["changes"] == {}
        applied = client.post(
            endpoint, headers=HEADERS, json=base | {"selections": [approve(item)]}
        )
        assert applied.status_code == 202, applied.text
        assert wait_job(client, library, applied.json()["id"])["status"] == "completed"
        assert (managed / track["path"]).samefile(original)
        result = client.get(metadata, headers=headers).json()
        assert result["overrides"] == overrides
        assert {key: result["effective"][key] for key in overrides} == overrides
        assert result["version"] == edited.json()["version"]


def test_batch_leaves_shared_source_unassigned_and_applies_other_matches(
    settings, authenticated_client, tmp_path
):
    incoming = tmp_path / "incoming"
    incoming.mkdir()
    first = source(settings, "first.flac", "First").rename(incoming / "first.flac")
    second = source(settings, "second.flac", "Second").rename(incoming / "second.flac")
    unique = incoming / "unique.mp3"
    shutil.copyfile(FIXTURES / "silence.mp3", unique)
    managed = tmp_path / "managed"
    with authenticated_client(settings) as client:
        library = start_library(settings, client, incoming, managed)
        tracks = tracks_in(settings, library)
        duplicates = [tracks["First"], tracks["Second"]]
        (other,) = [track for track in tracks.values() if track["path"].endswith(".mp3")]
        shared = first.rename(incoming / "shared.flac")
        second.unlink()
        shutil.copyfile(shared, managed / duplicates[1]["path"])

        endpoint = f"/api/v1/libraries/{library['id']}/rebind"
        base = {"version": library["version"], "target_storage_mode": "hardlink"}
        preview = client.post(endpoint + "/preview", headers=HEADERS, json=base)
        assert preview.status_code == 200, preview.text
        items = {item["track_id"]: item for item in preview.json()["items"]}
        for track in duplicates:
            item = items[track["id"]]
            assert (item["action"], item["reason"]) == ("keep", "ambiguous"), item
            assert "token" not in item
        assert items[other["id"]]["action"] == "exact"
        selections = [approve(item) for item in items.values() if "token" in item]
        applied = client.post(endpoint, headers=HEADERS, json=base | {"selections": selections})
        assert applied.status_code == 202, applied.text
        assert wait_job(client, library, applied.json()["id"])["status"] == "completed"
        assert (managed / other["path"]).samefile(unique)
        assert all(not (managed / track["path"]).samefile(shared) for track in duplicates)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="FLAC PCM equality needs FFmpeg")
@pytest.mark.parametrize("move", [False, True])
def test_batch_rebind_preserves_fresh_tags_and_skips_unapproved_track(
    settings, authenticated_client, tmp_path, move
):
    incoming = tmp_path / "incoming"
    incoming.mkdir()
    original = source(settings, "one.flac", "Source title").rename(incoming / "one.flac")
    source(settings, "two.flac", "Skip this").rename(incoming / "two.flac")
    managed = tmp_path / "managed"
    with authenticated_client(settings) as client:
        library = start_library(settings, client, incoming, managed)
        tracks = tracks_in(settings, library)
        track = tracks["Source title"]
        old = managed / track["path"]
        database = Database(settings.data_dir)
        artwork = settings.data_dir / "artwork"
        artwork.mkdir(exist_ok=True)
        track_cover = _solid_image((0, 70, 120), "JPEG")
        with database.connect(write=True) as db:
            for record, cover in (
                (track, track_cover),
                (tracks["Skip this"], _solid_image((200, 70, 20), "JPEG")),
            ):
                content_hash = hashlib.sha256(cover).hexdigest()
                (artwork / content_hash).write_bytes(cover)
                db.execute(
                    "INSERT INTO artwork_choices(track_id,filename,source_url,mode) VALUES (?,?,'upload','chosen')",
                    (record["id"], content_hash),
                )
        export_music(database, managed, library["id"])
        (portable_cover,) = managed.rglob(".wildstring/covers/*.jpg")
        assert portable_cover.stem == hashlib.sha256(old.read_bytes()).hexdigest()
        source_tags = FLAC(original)
        source_tags["encoder"] = "Lossless encoder"
        source_tags["replaygain_track_gain"] = "-1.0 dB"
        source_tags["replaygain_track_peak"] = "0.95"
        source_tags["replaygain_album_gain"] = "-2.0 dB"
        source_tags["replaygain_album_peak"] = "0.97"
        source_tags["replaygain_reference_loudness"] = "89.0 dB"
        source_tags["replaygain_track_range"] = "4.0 dB"
        source_tags["replaygain_album_range"] = "5.0 dB"
        source_tags["lyrics"] = "[00:01.000]Source lyric"
        source_tags.save()
        lyric = "[00:01.000]Preserved lyric"
        old_tags = FLAC(old)
        old_tags["title"] = "Edited outside WildString"
        old_tags["syncedlyrics"] = lyric
        old_tags.save()
        old_bytes = old.read_bytes()
        destination = tmp_path / "moved" if move else managed
        base = {
            "version": library["version"],
            "target_storage_mode": "hardlink",
            "managed_root": str(destination),
        }
        endpoint = f"/api/v1/libraries/{library['id']}/rebind"
        preview = client.post(endpoint + "/preview", headers=HEADERS, json=base)
        assert preview.status_code == 200, preview.text
        items = {item["track_id"]: item for item in preview.json()["items"]}
        reviewed = items[track["id"]]
        assert reviewed["action"] == "equivalent", reviewed
        assert set(reviewed["changes"]) == {"title", "lyrics"}
        assert reviewed["changes"]["title"] == {
            "value": "Edited outside WildString",
            "source": "Source title",
        }
        assert reviewed["changes"]["lyrics"] == {
            "source": "[00:01.000]Source lyric",
            "value": lyric,
        }
        assert items[tracks["Skip this"]["id"]]["action"] == "exact"
        applied = client.post(
            endpoint, headers=HEADERS, json=base | {"selections": [approve(reviewed)]}
        )
        assert applied.status_code == 202, applied.text
        job = wait_job(client, library, applied.json()["id"])
        assert job["status"] == "completed", job
        assert "rebind_plan" not in job
        assert (destination / track["path"]).samefile(original)
        assert not (destination / tracks["Skip this"]["path"]).samefile(incoming / "two.flac")
        if move:
            assert old.read_bytes() == old_bytes
        result = tracks_in(settings, library)["Edited outside WildString"]
        assert result["id"] == track["id"]
        (manifest,) = destination.rglob(".wildstring/manifest.json")
        assert any(
            item["sha256"] == hashlib.sha256(original.read_bytes()).hexdigest()
            and item["title"] == "Edited outside WildString"
            and "title" in item["locked_fields"]
            for item in json.loads(manifest.read_text())["tracks"]
        )
        (portable_lyric,) = destination.rglob(".wildstring/lyrics/*.lrc")
        assert portable_lyric.stem == result["sha256"]
        assert portable_lyric.read_text() == lyric
        with database.connect(scoped=False) as db:
            assert (
                db.execute(
                    "SELECT text FROM track_lyrics WHERE track_id=?", (track["id"],)
                ).fetchone()[0]
                == lyric
            )
        (portable_cover,) = destination.rglob(".wildstring/covers/*.jpg")
        assert portable_cover.stem == result["sha256"]
        assert portable_cover.read_bytes() == track_cover
        headers = HEADERS | {"X-Wildstring-Library": library["id"]}
        assert (
            client.get(f"/api/v1/tracks/{track['id']}/stream", headers=headers).status_code == 200
        )


def test_rebind_only_stale_preview_and_permissions(settings, authenticated_client, tmp_path):
    incoming = tmp_path / "incoming"
    incoming.mkdir()
    original = source(settings, "one.flac", "Original").rename(incoming / "one.flac")
    managed = tmp_path / "managed"
    with authenticated_client(settings) as client:
        library = start_library(settings, client, incoming, managed)
        track = tracks_in(settings, library)["Original"]
        old = managed / track["path"]
        digest = hashlib.sha256(old.read_bytes()).hexdigest()
        source_id = library["sources"][0]["id"]
        path = incoming / "other.mp3"
        shutil.copyfile(FIXTURES / "playback.mp3", path)
        choice = {"track_id": track["id"], "source_id": source_id, "source_path": path.name}
        url = f"/api/v1/libraries/{library['id']}/rebind"
        base = {"version": library["version"]}
        reviewed = client.post(url + "/preview", headers=HEADERS, json=base | {"choice": choice})
        assert reviewed.status_code == 200, reviewed.text
        (item,) = reviewed.json()["items"]
        assert item["action"] == "bind"
        other, _ = listener(client, [library["id"]], profile="librarian")
        try:
            assert (
                other.post(
                    url + "/preview", headers=HEADERS, json=base | {"choice": choice}
                ).status_code
                == 403
            )
        finally:
            other.close()
        with path.open("ab") as stream:
            stream.write(b"change approved bytes")
        stale = client.post(url, headers=HEADERS, json=base | {"selections": [approve(item)]})
        assert stale.status_code == 409 and stale.json()["detail"] == "rebind_preview_changed"
        (item,) = client.post(
            url + "/preview", headers=HEADERS, json=base | {"choice": choice}
        ).json()["items"]
        applied = client.post(url, headers=HEADERS, json=base | {"selections": [approve(item)]})
        assert applied.status_code == 202, applied.text
        assert wait_job(client, library, applied.json()["id"])["status"] == "completed"
        assert hashlib.sha256(old.read_bytes()).hexdigest() == digest
        assert old.stat().st_ino != original.stat().st_ino
        with Database(settings.data_dir).connect(scoped=False) as db:
            rows = db.execute(
                "SELECT source_path,link_mode,sha256 FROM imported_files WHERE target_root=?",
                (str(managed),),
            ).fetchall()
            assert [tuple(row) for row in rows] == [
                (path.name, "managed_only", hashlib.sha256(path.read_bytes()).hexdigest())
            ]
        assert tracks_in(settings, library)["Original"]["sha256"] == digest


@pytest.mark.parametrize("other_volume", [False, True])
def test_m4a_binding_keeps_independent_file(
    settings, authenticated_client, tmp_path, monkeypatch, other_volume
):
    incoming = tmp_path / "incoming"
    incoming.mkdir()
    original = incoming / "one.m4a"
    shutil.copyfile(FIXTURES / "silence.m4a", original)
    managed = tmp_path / "managed"
    with authenticated_client(settings) as client:
        library = start_library(settings, client, incoming, managed)
        (track,) = tracks_in(settings, library).values()
        target = managed / track["path"]
        if other_volume:
            original_init = MusicRebind.__init__

            def different_device(service, *args):
                original_init(service, *args)
                service.device = -1

            monkeypatch.setattr(MusicRebind, "__init__", different_device)
        else:
            with original.open("ab") as stream:
                stream.write(b"different source bytes")
        endpoint = f"/api/v1/libraries/{library['id']}/rebind"
        base = {"version": library["version"]}
        choice = {
            "track_id": track["id"],
            "source_id": library["sources"][0]["id"],
            "source_path": original.name,
        }
        preview = client.post(
            endpoint + "/preview", headers=HEADERS, json=base | {"choice": choice}
        )
        assert preview.status_code == 200, preview.text
        (item,) = preview.json()["items"]
        assert item["action"] == "bind"
        assert item["reason"] == ("differentVolume" if other_volume else "differentBytes")
        applied = client.post(
            endpoint, headers=HEADERS, json=base | {"selections": [approve(item)]}
        )
        assert applied.status_code == 202, applied.text
        assert wait_job(client, library, applied.json()["id"])["status"] == "completed"
        assert not target.samefile(original)
        assert target.read_bytes() == (FIXTURES / "silence.m4a").read_bytes()


def test_batch_updates_renamed_source_of_already_linked_track(
    settings, authenticated_client, tmp_path
):
    incoming = tmp_path / "incoming"
    incoming.mkdir()
    original = source(settings, "one.flac", "Track").rename(incoming / "one.flac")
    managed = tmp_path / "managed"
    with authenticated_client(settings) as client:
        library = start_library(settings, client, incoming, managed)
        track = tracks_in(settings, library)["Track"]
        target = managed / track["path"]
        target.unlink()
        target.hardlink_to(original)
        renamed = original.rename(incoming / "renamed.flac")
        endpoint = f"/api/v1/libraries/{library['id']}/rebind"
        base = {"version": library["version"], "target_storage_mode": "hardlink"}
        preview = client.post(endpoint + "/preview", headers=HEADERS, json=base)
        assert preview.status_code == 200, preview.text
        (item,) = preview.json()["items"]
        assert (item["action"], item["source_path"]) == ("exact", renamed.name)
        applied = client.post(
            endpoint, headers=HEADERS, json=base | {"selections": [approve(item)]}
        )
        assert applied.status_code == 202, applied.text
        assert wait_job(client, library, applied.json()["id"])["status"] == "completed"
        headers = HEADERS | {"X-Wildstring-Library": library["id"]}
        info = client.get(f"/api/v1/tracks/{track['id']}/file-info", headers=headers).json()
        assert info["source_filename"] == renamed.name
        assert target.samefile(renamed)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="FLAC PCM equality needs FFmpeg")
@pytest.mark.parametrize("legacy_plan", [False, True])
def test_in_place_rebind_retries_after_publishing_file(
    settings, authenticated_client, tmp_path, monkeypatch, legacy_plan
):
    incoming = tmp_path / "incoming"
    incoming.mkdir()
    original = source(settings, "one.flac", "Before").rename(incoming / "one.flac")
    managed = tmp_path / "managed"
    with authenticated_client(settings) as client:
        library = start_library(settings, client, incoming, managed)
        track = tracks_in(settings, library)["Before"]
        target = managed / track["path"]
        tags = FLAC(target)
        tags["title"] = "Preserved"
        tags.save()
        endpoint = f"/api/v1/libraries/{library['id']}/rebind"
        base = {"version": library["version"], "target_storage_mode": "hardlink"}
        (item,) = client.post(endpoint + "/preview", headers=HEADERS, json=base).json()["items"]
        apply = LibraryStorage.persist_rebind_item

        def fail_once(service, db, job_id, name, item):
            if item.get("done"):
                monkeypatch.setattr(LibraryStorage, "persist_rebind_item", apply)
                raise OSError("simulated failure before track commit")
            return apply(service, db, job_id, name, item)

        monkeypatch.setattr(LibraryStorage, "persist_rebind_item", fail_once)
        job_id = client.post(
            endpoint, headers=HEADERS, json=base | {"selections": [approve(item)]}
        ).json()["id"]
        assert wait_job(client, library, job_id)["status"] == "failed"
        assert target.samefile(original)
        assert tracks_in(settings, library)["Preserved"]["id"] == track["id"]
        if legacy_plan:
            with Database(settings.data_dir).connect(write=True) as db:
                (saved,) = db.execute(
                    "SELECT path,state FROM library_rebind_items WHERE migration_id=?", (job_id,)
                )
                old_plan = {"single": False, "items": {saved["path"]: json.loads(saved["state"])}}
                db.execute(
                    "UPDATE library_migrations SET rebind_plan=? WHERE id=?",
                    (json.dumps(old_plan), job_id),
                )
                db.execute("DELETE FROM library_rebind_items WHERE migration_id=?", (job_id,))
        retry = client.post(
            f"/api/v1/libraries/{library['id']}/migrations/{job_id}/retry", headers=HEADERS
        )
        assert retry.status_code == 202, retry.text
        job = wait_job(client, library, job_id)
        assert job["status"] == "completed", job
        assert (
            tracks_in(settings, library)["Preserved"]["sha256"]
            == hashlib.sha256(original.read_bytes()).hexdigest()
        )


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="FLAC PCM equality needs FFmpeg")
@pytest.mark.parametrize("tag", ["comment", "custom_tag"])
def test_equivalent_flac_keeps_unmapped_tags(settings, authenticated_client, tmp_path, tag):
    incoming = tmp_path / "incoming"
    incoming.mkdir()
    source(settings, "one.flac", "Track").rename(incoming / "one.flac")
    managed = tmp_path / "managed"
    with authenticated_client(settings) as client:
        library = start_library(settings, client, incoming, managed)
        target = managed / tracks_in(settings, library)["Track"]["path"]
        tags = FLAC(target)
        tags[tag] = "Edited locally"
        tags.save()
        endpoint = f"/api/v1/libraries/{library['id']}/rebind"
        base = {"version": library["version"], "target_storage_mode": "hardlink"}
        preview = client.post(endpoint + "/preview", headers=HEADERS, json=base)
        assert preview.status_code == 200, preview.text
        (item,) = preview.json()["items"]
        assert (item["action"], item["reason"]) == ("bind", "unsupportedTags")


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="FLAC PCM equality needs FFmpeg")
@pytest.mark.parametrize(
    ("local_lyrics", "override", "action"),
    [
        (None, None, "bind"),
        (["Plain lyric", "Second block"], None, "bind"),
        ("<script>unsafe</script>", None, "bind"),
        ("[00:98]Invalid timestamp", None, "bind"),
        (None, "[00:01.000]Application lyric", "equivalent"),
        (None, "", "equivalent"),
    ],
)
def test_embedded_lyrics_respect_existing_overrides_and_safe_transfer(
    settings, authenticated_client, tmp_path, local_lyrics, override, action
):
    incoming = tmp_path / "incoming"
    incoming.mkdir()
    original = source(settings, "one.flac", "Track").rename(incoming / "one.flac")
    tags = FLAC(original)
    tags["lyrics"] = "[00:01.000]Source lyric"
    tags.save()
    managed = tmp_path / "managed"
    with authenticated_client(settings) as client:
        library = start_library(settings, client, incoming, managed)
        track = tracks_in(settings, library)["Track"]
        target = managed / track["path"]
        tags = FLAC(target)
        del tags["lyrics"]
        if local_lyrics is not None:
            tags["unsynced lyrics"] = local_lyrics
        tags.save()
        database = Database(settings.data_dir)
        if override is not None:
            with database.connect(write=True) as db:
                db.execute(
                    "INSERT INTO track_lyrics(track_id,text,version) VALUES (?,?,2)",
                    (track["id"], override),
                )
        endpoint = f"/api/v1/libraries/{library['id']}/rebind"
        base = {"version": library["version"], "target_storage_mode": "hardlink"}
        preview = client.post(endpoint + "/preview", headers=HEADERS, json=base)
        assert preview.status_code == 200, preview.text
        (item,) = preview.json()["items"]
        assert item["action"] == action, item
        assert item["changes"] == {}
        if action == "bind":
            assert item["reason"] == "unsupportedTags"
        else:
            applied = client.post(
                endpoint, headers=HEADERS, json=base | {"selections": [approve(item)]}
            )
            assert applied.status_code == 202, applied.text
            assert wait_job(client, library, applied.json()["id"])["status"] == "completed"
            assert target.samefile(original)
            with database.connect(scoped=False) as db:
                assert tuple(
                    db.execute(
                        "SELECT text,version FROM track_lyrics WHERE track_id=?", (track["id"],)
                    ).fetchone()
                ) == (override, 2)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="FLAC PCM equality needs FFmpeg")
@pytest.mark.parametrize("before_submit", [True, False])
def test_rebind_rejects_lyrics_changed_after_preview(
    settings, authenticated_client, tmp_path, monkeypatch, before_submit
):
    incoming = tmp_path / "incoming"
    incoming.mkdir()
    original = source(settings, "one.flac", "Track").rename(incoming / "one.flac")
    managed = tmp_path / "managed"
    with authenticated_client(settings) as client:
        library = start_library(settings, client, incoming, managed)
        track = tracks_in(settings, library)["Track"]
        target = managed / track["path"]
        tags = FLAC(target)
        tags["lyrics"] = "Embedded lyric"
        tags.save()
        endpoint = f"/api/v1/libraries/{library['id']}/rebind"
        base = {"version": library["version"], "target_storage_mode": "hardlink"}
        (item,) = client.post(endpoint + "/preview", headers=HEADERS, json=base).json()["items"]
        assert item["action"] == "equivalent", item
        database = Database(settings.data_dir)

        def edit_lyrics():
            with database.connect(write=True) as db:
                db.execute(
                    "INSERT INTO track_lyrics(track_id,text) VALUES (?, 'New application lyric')",
                    (track["id"],),
                )

        original_source = LibraryStorage.rebind_source

        def edit_before_stage(service, job, plan):
            edit_lyrics()
            return original_source(service, job, plan)

        if before_submit:
            edit_lyrics()
        else:
            monkeypatch.setattr(LibraryStorage, "rebind_source", edit_before_stage)
        applied = client.post(
            endpoint, headers=HEADERS, json=base | {"selections": [approve(item)]}
        )
        if before_submit:
            assert (
                applied.status_code == 409 and applied.json()["detail"] == "rebind_preview_changed"
            )
        else:
            assert applied.status_code == 202, applied.text
            job = wait_job(client, library, applied.json()["id"])
            assert (job["status"], job["error"]) == ("failed", "rebind_preview_changed"), job
        assert not target.samefile(original)
        with database.connect(scoped=False) as db:
            assert (
                db.execute(
                    "SELECT text FROM track_lyrics WHERE track_id=?", (track["id"],)
                ).fetchone()[0]
                == "New application lyric"
            )


@pytest.mark.parametrize("interrupt", [False, True])
def test_in_place_rebind_publishes_once_per_album_and_recovers_pending_sidecars(
    settings, authenticated_client, tmp_path, monkeypatch, interrupt
):
    incoming = tmp_path / "incoming"
    incoming.mkdir()
    originals = {
        title: source(settings, f"{title}.flac", title).rename(incoming / f"{title}.flac")
        for title in ("First", "Second", "Other")
    }
    tags = FLAC(originals["Other"])
    tags["album"] = "龟山专辑"
    tags.save()
    managed = tmp_path / "managed"
    with authenticated_client(settings) as client:
        library = start_library(settings, client, incoming, managed)
        tracks = tracks_in(settings, library)
        endpoint = f"/api/v1/libraries/{library['id']}/rebind"
        base = {"version": library["version"], "target_storage_mode": "hardlink"}
        items = client.post(endpoint + "/preview", headers=HEADERS, json=base).json()["items"]
        assert [item["action"] for item in items] == ["exact"] * 3
        exports, hashes = [], []
        original_export = storage.export_music
        original_track = LibraryStorage.rebind_track
        hash_file = rebind.digest
        reading_track = False

        def record_hash(stream):
            if reading_track:
                hashes.append(stream.name)
            return hash_file(stream)

        def record_export(database, root, library_id, folders, **kwargs):
            exports.append(folders)
            return original_export(database, root, library_id, folders, **kwargs)

        def track_with_interrupt(service, job, root, item):
            nonlocal reading_track
            if interrupt and len(hashes) == 2:
                monkeypatch.setattr(LibraryStorage, "rebind_track", original_track)
                raise OSError("simulated failure partway through an album")
            reading_track = True
            try:
                return original_track(service, job, root, item)
            finally:
                reading_track = False

        monkeypatch.setattr(rebind, "digest", record_hash)
        monkeypatch.setattr(import_files, "digest", record_hash)
        monkeypatch.setattr(storage, "export_music", record_export)
        monkeypatch.setattr(LibraryStorage, "rebind_track", track_with_interrupt)
        applied = client.post(
            endpoint, headers=HEADERS, json=base | {"selections": [approve(item) for item in items]}
        )
        assert applied.status_code == 202, applied.text
        job_id = applied.json()["id"]
        job = wait_job(client, library, job_id)
        database = Database(settings.data_dir)
        if interrupt:
            assert job["status"] == "failed", job
            assert not exports
            with database.connect(scoped=False) as db:
                states = [
                    json.loads(row[0])
                    for row in db.execute(
                        "SELECT state FROM library_rebind_items WHERE migration_id=?", (job_id,)
                    )
                ]
                (finished,) = [item for item in states if item.get("done")]
                assert set(finished) == {
                    "done",
                    "previous_sha",
                    "managed_sha",
                    "action",
                    "reclaimed",
                }
            retried = client.post(
                f"/api/v1/libraries/{library['id']}/migrations/{job_id}/retry", headers=HEADERS
            )
            assert retried.status_code == 202, retried.text
            job = wait_job(client, library, job_id)
            assert len(exports) == 3 and exports[0] == exports[1]
        else:
            assert len(exports) == 2 and exports[0] != exports[1]
            assert job["sidecars_written"] == 2
            assert len(hashes) == 6
        assert job["status"] == "completed" and job["relinked_files"] == 3, job
        assert all(
            (managed / tracks[title]["path"]).samefile(path) for title, path in originals.items()
        )
        assert len(list(managed.rglob(".wildstring/manifest.json"))) == 2
        with database.connect(scoped=False) as db:
            assert (
                db.execute(
                    "SELECT count(*) FROM library_rebind_items WHERE migration_id=?", (job_id,)
                ).fetchone()[0]
                == 0
            )
