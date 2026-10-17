"""Intake policy, immutable source snapshots, recovery and exact CUE conversion."""

import hashlib
import shutil
import struct
import subprocess
import time
import wave
from pathlib import Path

import pytest
from conftest import restore_v7_account_layout
from mutagen.flac import FLAC

from wildstring.database import Database
from wildstring.library.conversion import convert
from wildstring.library.cue import parse_cue
from wildstring.library.importer import import_music
from wildstring.library.intake import Intake, IntakeApproval, IntakeSettings
from wildstring.library.repository import LibraryRepository
from wildstring.library.scanner import scan_library
from wildstring.management import Management

FIXTURE = Path(__file__).parents[2] / "tests/fixtures/audio/silence.flac"
HEADERS = {"X-Wildstring-Client": "web"}


def setup(settings):
    settings.music_dir.mkdir(exist_ok=True)
    settings.data_dir.mkdir(exist_ok=True)
    database = Database(settings.data_dir)
    database.initialize()
    repository = LibraryRepository(database, settings.library_dir)
    repository.library_id(create=True)
    return Intake(settings, repository)


def source(settings, name="测试.flac", complete=True):
    settings.music_dir.mkdir(exist_ok=True)
    path = settings.music_dir / name
    shutil.copyfile(FIXTURE, path)
    tags = FLAC(path)
    tags.clear()
    if complete:
        tags.update(
            title=["测试歌"],
            artist=["艺人"],
            album=["专辑"],
            albumartist=["艺人"],
            tracknumber=["1"],
        )
    tags.save()
    return path


def test_stability_survives_restart_and_sidecar_restarts_clock(settings):
    intake = setup(settings)
    path = source(settings)
    (settings.music_dir / ".downloads").mkdir()
    source(settings, ".downloads/hidden.flac")
    intake.configure(IntakeSettings(version=1, enabled=True, interval_seconds=15, stable_seconds=5))
    assert not intake.has_work()
    row = intake.items()["items"][0]
    assert row["state"] == "waiting"
    with intake.database.connect(write=True) as con:
        con.execute("UPDATE intake_items SET changed_at=changed_at-10")
    restarted = Intake(settings, intake.repository)
    assert restarted.has_work()
    path.with_suffix(".lrc").write_text("[00:00]新歌词")
    assert not restarted.has_work()
    assert restarted.items()["items"][0]["version"] == 2
    report = import_music(settings, automatic=True)
    assert report["counts"]["waiting"] == 1 and not list(settings.library_dir.rglob("*.flac"))


def test_review_snapshot_approval_and_rescan_preserve_identity(settings):
    intake = setup(settings)
    path = source(settings, complete=False)
    original = path.read_bytes()
    report = import_music(settings)
    assert report["counts"]["review"] == 1
    item = intake.items()["items"][0]
    assert item["can_approve"] and item["state"] == "review"
    staged = settings.data_dir / "intake" / intake.item(item["id"])["staged"]
    assert staged.read_bytes() == original
    assert not list(settings.library_dir.rglob("*.flac"))
    overrides = {
        "title": "新歌",
        "artists": ["AC/DC"],
        "album": "新专辑",
        "album_artists": ["AC/DC"],
        "track_number": 3,
        "disc_number": 1,
    }
    intake.approve(item["id"], IntakeApproval(version=item["version"], overrides=overrides))
    report = import_music(settings, automatic=True)
    assert report["counts"]["copied"] == 1
    assert intake.item(item["id"])["staged"] == staged.relative_to(intake.root).as_posix()
    track = intake.repository.tracks()["items"][0]
    assert track["path"] == "AC_DC/新专辑/CD01/03 - 新歌.flac"
    assert track["title"] == "新歌" and track["artists"] == ["AC/DC"]
    scan_library(settings, full=True)
    assert intake.repository.tracks()["items"][0]["id"] == track["id"]
    assert intake.repository.tracks()["items"][0]["title"] == "新歌"
    assert import_music(settings)["counts"]["unchanged"] == 1
    assert path.read_bytes() == original


def test_source_change_invalidates_review_and_preserves_imported_copy(settings):
    intake = setup(settings)
    path = source(settings, complete=False)
    import_music(settings)
    item = intake.items()["items"][0]
    tags = FLAC(path)
    tags["title"] = "外部变化"
    tags.save()
    with pytest.raises(Exception, match="intake_source_changed"):
        intake.approve(
            item["id"],
            IntakeApproval(
                version=item["version"], overrides={"title": "歌", "artists": ["人"], "album": "碟"}
            ),
        )
    import_music(settings)
    assert intake.items()["items"][0]["version"] > item["version"]
    complete = source(settings, name="完整.flac")
    import_music(settings)
    track = intake.repository.tracks()["items"][0]
    before = (settings.library_dir / track["path"]).read_bytes()
    tags = FLAC(complete)
    tags["title"] = "不要覆盖"
    tags.save()
    assert import_music(settings)["counts"]["conflicts"] == 1
    assert (settings.library_dir / track["path"]).read_bytes() == before


def test_compilation_goes_to_review_and_sidecar_cue_can_fill_missing_tags(settings):
    intake = setup(settings)
    a = source(settings, "a.flac")
    b = source(settings, "b.flac")
    for path, artist in [(a, "甲"), (b, "乙")]:
        tags = FLAC(path)
        del tags["albumartist"]
        tags["artist"] = artist
        tags.save()
    assert import_music(settings)["counts"]["review"] == 2
    assert all("album_artist_ambiguous" in item["issues"] for item in intake.items()["items"])
    # Another directory contains already split files and a multi-FILE CUE.
    other = settings.music_dir / "分轨"
    other.mkdir()
    c = other / "01.flac"
    shutil.copyfile(FIXTURE, c)
    tags = FLAC(c)
    tags.clear()
    tags.save()
    (other / "album.cue").write_text(
        'PERFORMER "合辑艺人"\nTITLE "合辑"\nFILE "01.flac" WAVE\n TRACK 01 AUDIO\n TITLE "曲一"\n INDEX 01 00:00:00\n'
    )
    assert import_music(settings)["counts"]["copied"] == 1
    assert intake.repository.tracks()["items"][0]["title"] == "曲一"


def test_policy_auth_versions_ignore_and_changed_source_reappears(settings, authenticated_client):
    setup(settings)
    path = source(settings, complete=False)
    import_music(settings)
    with authenticated_client(settings) as client:
        url = "/api/v1/manage/intake"
        config = client.get(url + "/settings").json()
        assert not config["enabled"]
        assert client.put(url + "/settings", json=config).status_code == 403
        body = config | {"enabled": True, "interval_seconds": 15, "stable_seconds": 5}
        assert client.put(url + "/settings", headers=HEADERS, json=body).status_code == 200
        assert client.put(url + "/settings", headers=HEADERS, json=body).status_code == 409
        item = client.get(url + "/items").json()["items"][0]
        endpoint = url + "/items/" + item["id"]
        assert (
            client.post(
                endpoint + "/approve",
                headers=HEADERS,
                json={"version": item["version"], "overrides": {"title": "仍不完整"}},
            ).status_code
            == 422
        )
        assert (
            client.post(endpoint + "/ignore", headers=HEADERS, json={"version": True}).status_code
            == 422
        )
        assert (
            client.post(
                endpoint + "/ignore", headers=HEADERS, json={"version": item["version"]}
            ).status_code
            == 200
        )
        assert client.get(url + "/items").json()["total"] == 0
        tags = FLAC(path)
        tags["comment"] = "新版本"
        tags.save()
        import_music(settings)
        assert client.get(url + "/items").json()["total"] == 1


def test_worker_automatically_imports_after_stability_and_remembers_setting(settings):
    intake = setup(settings)
    path = source(settings)
    original = hashlib.sha256(path.read_bytes()).digest()
    intake.configure(IntakeSettings(version=1, enabled=True, interval_seconds=15, stable_seconds=5))
    assert not intake.has_work()
    with intake.database.connect(write=True) as con:
        con.execute("UPDATE intake_items SET changed_at=changed_at-10")
    worker = Management(settings, intake.repository)
    worker.start()
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and intake.repository.tracks()["total"] != 1:
            time.sleep(0.05)
        assert intake.repository.tracks()["total"] == 1
        assert intake.preferences()["enabled"]
        assert not intake.has_work()
    finally:
        worker.stop()
    assert hashlib.sha256(path.read_bytes()).digest() == original


@pytest.mark.parametrize(
    "text",
    [
        'FILE "../escape.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00',
        'FILE "x.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:75',
        'FILE "x.wav" WAVE\nTRACK 01 AUDIO\nPREGAP 00:02:00\nINDEX 01 00:00:00',
    ],
)
def test_cue_rejects_unsafe_or_ambiguous_recipes(text):
    with pytest.raises(ValueError):
        parse_cue(text.encode())


def wav(settings, width=2):
    settings.music_dir.mkdir(exist_ok=True)
    path = settings.music_dir / "整轨.wav"
    frames = b"".join(
        struct.pack("<hh", (i % 2000) - 1000, 1000 - (i % 2000)) for i in range(88200)
    )
    with wave.open(str(path), "wb") as output:
        output.setparams((2, width, 44100, 0, "NONE", "not compressed"))
        output.writeframes(frames)
    return path, frames


def require_ffmpeg():
    if not shutil.which("ffmpeg"):
        pytest.skip(
            "FFmpeg is required; make docker-test runs these cases with the packaged binary"
        )


def test_wav_cue_import_is_sample_exact_preserves_gaps_and_repeats(settings):
    require_ffmpeg()
    intake = setup(settings)
    path, frames = wav(settings)
    cue = 'PERFORMER "万芳"\nTITLE "真情"\nFILE "整轨.wav" WAVE\n TRACK 01 AUDIO\n TITLE "第一首"\n INDEX 01 00:00:00\n TRACK 02 AUDIO\n TITLE "第二首"\n INDEX 00 00:00:70\n INDEX 01 00:01:00\n'
    path.with_suffix(".cue").write_bytes(cue.encode("gb18030"))
    original = path.read_bytes()
    report = import_music(settings)
    assert report["status"] == "completed", report
    assert report["counts"]["converted"] == 2
    tracks = sorted(intake.repository.tracks()["items"], key=lambda x: x["track_number"])
    assert [x["title"] for x in tracks] == ["第一首", "第二首"]
    decoded = b""
    for track in tracks:
        target = settings.library_dir / track["path"]
        info = FLAC(target).info
        assert (info.sample_rate, info.channels, info.bits_per_sample) == (44100, 2, 16)
        decoded += subprocess.run(
            [shutil.which("ffmpeg"), "-v", "error", "-i", str(target), "-f", "s16le", "pipe:1"],
            capture_output=True,
            check=True,
        ).stdout
    assert decoded == frames and path.read_bytes() == original
    assert list((settings.data_dir / "intake").rglob("source.cue"))
    assert import_music(settings)["counts"]["unchanged"] == 1
    assert len(list(settings.library_dir.rglob("*.flac"))) == 2


def test_cue_out_of_bounds_and_float_or_unsupported_wav_never_publish(settings):
    require_ffmpeg()
    intake = setup(settings)
    path, _ = wav(settings)
    cue = 'PERFORMER "人"\nTITLE "碟"\nFILE "整轨.wav" WAVE\nTRACK 01 AUDIO\nTITLE "一"\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nTITLE "二"\nINDEX 01 99:00:00\n'
    path.with_suffix(".cue").write_text(cue)
    report = import_music(settings)
    assert report["counts"]["errors"] == 1
    assert not list(settings.library_dir.rglob("*.flac"))
    assert intake.items()["items"][0]["issues"] == ["cue_out_of_bounds"]


def test_plain_wav_review_then_convert_and_pcm_failure_does_not_publish(settings, monkeypatch):
    require_ffmpeg()
    intake = setup(settings)
    path, _ = wav(settings)
    assert import_music(settings)["counts"]["review"] == 1
    item = intake.items()["items"][0]
    intake.approve(
        item["id"],
        IntakeApproval(
            version=item["version"],
            overrides={"title": "曲", "artists": ["人"], "album": "碟", "album_artists": ["人"]},
        ),
    )
    assert import_music(settings)["counts"]["converted"] == 1
    assert intake.repository.tracks()["items"][0]["title"] == "曲"
    with path.open("rb") as stream:
        with pytest.raises(ValueError, match="cue_hidden_pregap"):
            convert(
                stream,
                settings.data_dir / "invalid",
                parse_cue(b'FILE "x.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:01'),
            )


def test_v6_upgrade_preserves_existing_jobs_tracks_and_settings(settings):
    intake = setup(settings)
    source(settings)
    import_music(settings)
    ids = [r["id"] for r in intake.repository.tracks()["items"]]
    with intake.database.connect(write=True) as con:
        restore_v7_account_layout(con)
        con.execute("DROP TABLE intake_items")
        con.execute("DROP TABLE intake_settings")
        con.execute("ALTER TABLE admin_jobs DROP COLUMN automatic")
        from migration_support import pre18

        pre18(con)
        con.execute("PRAGMA user_version=6")
    intake.database.initialize()
    assert [r["id"] for r in intake.repository.tracks()["items"]] == ids
    assert not intake.preferences()["enabled"]
    assert intake.database.check_ready()


@pytest.mark.parametrize("after_approval", [False, True])
def test_bad_neighbor_does_not_block_review_and_snapshot_tampering_is_rejected(
    settings, after_approval
):
    intake = setup(settings)
    source(settings, complete=False)
    (settings.music_dir / "broken.flac").write_bytes(b"broken")
    report = import_music(settings)
    assert report["counts"]["review"] == 1 and report["counts"]["errors"] == 1
    item = next(row for row in intake.items()["items"] if row["state"] == "review")
    staged = intake.root / intake.item(item["id"])["staged"]
    approval = IntakeApproval(
        version=item["version"], overrides={"title": "曲", "artists": ["人"], "album": "碟"}
    )
    if after_approval:
        intake.approve(item["id"], approval)
    staged.write_bytes(b"changed snapshot")
    if after_approval:
        import_music(settings, automatic=True)
        assert intake.item(item["id"])["issues"] == ["intake_snapshot_changed"]
        assert not list(settings.library_dir.rglob("*.flac"))
    else:
        with pytest.raises(Exception, match="intake_snapshot_changed"):
            intake.approve(item["id"], approval)


def test_clearing_import_override_is_not_undone_by_next_import(settings):
    import json

    from wildstring.library.edits import MetadataEditor, MetadataUpdate

    intake = setup(settings)
    source(settings)
    tags = FLAC(settings.music_dir / "测试.flac")
    del tags["artist"]
    tags.save()
    import_music(settings)
    track = intake.repository.tracks()["items"][0]
    editor = MetadataEditor(intake.repository)
    current = editor.read(track["id"])
    assert current["overrides"]["artists"] == ["艺人"]
    editor.save(track["id"], MetadataUpdate(version=current["version"], overrides={}))
    import_music(settings)
    assert editor.read(track["id"])["overrides"] == {}
    with intake.database.connect() as con:
        assert json.loads(con.execute("SELECT outputs FROM intake_items").fetchone()[0])[0][
            "applied"
        ]


def test_24bit_conversion_and_float_wav_rejection(settings):
    require_ffmpeg()
    setup(settings)
    path = settings.music_dir / "24bit.wav"
    data = b"".join((i - 100).to_bytes(3, "little", signed=True) for i in range(3000))
    with wave.open(str(path), "wb") as audio:
        audio.setparams((1, 3, 48000, 0, "NONE", "not compressed"))
        audio.writeframes(data)
    with path.open("rb") as stream:
        outputs = convert(
            stream,
            settings.data_dir / "24bit",
            metadata={"title": "24bit", "artists": ["测试"], "album": "测试"},
        )
    assert FLAC(outputs[0]).info.bits_per_sample == 24
    before = path.read_bytes()
    altered = bytearray(before)
    altered[20:22] = struct.pack("<H", 3)
    path.write_bytes(altered)
    with path.open("rb") as stream:
        with pytest.raises(ValueError, match="wav_not_integer_pcm"):
            convert(stream, settings.data_dir / "float")
    assert not list((settings.data_dir / "float").glob("*.flac"))


def test_removed_approved_source_does_not_queue_empty_jobs(settings):
    intake = setup(settings)
    path = source(settings, complete=False)
    import_music(settings)
    item = intake.items()["items"][0]
    intake.approve(
        item["id"],
        IntakeApproval(
            version=item["version"], overrides={"title": "曲", "artists": ["人"], "album": "碟"}
        ),
    )
    path.unlink()
    assert not intake.has_work()
    assert intake.items()["items"][0]["state"] == "failed"
    assert intake.items()["items"][0]["issues"] == ["source_missing"]
    assert (intake.root / intake.item(item["id"])["staged"]).is_file()


def test_flac_image_cue_is_verified_and_retains_embedded_cover(settings):
    import io

    from mutagen.flac import Picture
    from PIL import Image

    require_ffmpeg()
    intake = setup(settings)
    path, _ = wav(settings)
    with path.open("rb") as stream:
        image = convert(
            stream,
            settings.data_dir / "image",
            metadata={"title": "整轨", "artists": ["人"], "album": "碟"},
        )[0]
    target = settings.music_dir / "image.flac"
    shutil.copyfile(image, target)
    picture = Picture()
    picture.type = 3
    picture.mime = "image/png"
    stream = io.BytesIO()
    Image.new("RGB", (4, 4), "red").save(stream, format="PNG")
    picture.data = stream.getvalue()
    tags = FLAC(target)
    tags.add_picture(picture)
    tags.save()
    target.with_suffix(".cue").write_text(
        'PERFORMER "人"\nTITLE "碟"\nFILE "image.flac" WAVE\nTRACK 01 AUDIO\nTITLE "一"\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nTITLE "二"\nINDEX 00 00:00:70\nINDEX 01 00:01:00\n'
    )
    path.unlink()
    before = target.read_bytes()
    report = import_music(settings)
    assert report["counts"]["converted"] == 2, report
    for track in intake.repository.tracks()["items"]:
        assert FLAC(settings.library_dir / track["path"]).pictures[0].data == picture.data
    assert target.read_bytes() == before


def test_retry_during_busy_scan_persists_and_runs_when_lock_released(
    settings, authenticated_client
):
    from filelock import FileLock

    intake = setup(settings)
    path = settings.music_dir / "修复.flac"
    path.write_bytes(b"broken")
    import_music(settings)
    item = intake.items()["items"][0]
    path.unlink()
    source(settings, "修复.flac")
    with authenticated_client(settings) as client:
        with FileLock(settings.data_dir / "library-scan.lock"):
            assert (
                client.post(
                    "/api/v1/manage/jobs", headers=HEADERS, json={"kind": "scan"}
                ).status_code
                == 202
            )
            response = client.post(
                f"/api/v1/manage/intake/items/{item['id']}/retry",
                headers=HEADERS,
                json={"version": item["version"]},
            )
            assert response.status_code == 200, response.text
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline and intake.repository.tracks()["total"] != 1:
            time.sleep(0.05)
        assert intake.repository.tracks()["total"] == 1
        assert not intake.preferences()["enabled"]
