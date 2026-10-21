"""Download markers protect albums without changing existing source identities."""

import pytest
from test_intake import setup, source

from wildstring.database import SCHEMA_VERSION, Database
from wildstring.library.importer import import_music
from wildstring.library.intake import IntakeApproval, IntakeSettings


def age(intake):
    with intake.database.connect(write=True) as db:
        db.execute("UPDATE intake_items SET changed_at=changed_at-100")
        db.execute("UPDATE intake_download_state SET changed_at=changed_at-100")


def configure(intake, **policy):
    intake.configure(
        IntakeSettings(
            version=intake.preferences()["version"],
            enabled=True,
            interval_seconds=15,
            stable_seconds=5,
            download_policy=policy or None,
        )
    )


def test_partial_file_and_directory_rename_discover_once(settings):
    intake = setup(settings)
    configure(intake)
    directory = settings.music_dir / "Album.part"
    directory.mkdir()
    path = source(settings, "Album.part/song.flac")
    original = path.read_bytes()
    assert list(intake.paths()) == []
    assert import_music(settings)["counts"]["copied"] == 0
    directory.rename(settings.music_dir / "Album")
    path = settings.music_dir / "Album/song.flac"
    path.rename(path.with_suffix(".flac.part"))
    assert list(intake.paths()) == []
    path.with_suffix(".flac.part").rename(path)
    assert not intake.has_work()
    age(intake)
    assert intake.has_work()
    assert import_music(settings, automatic=True)["counts"]["copied"] == 1
    identity = intake.repository.tracks()["items"][0]["id"]
    assert import_music(settings, automatic=True)["counts"]["unchanged"] == 1
    assert intake.repository.tracks()["items"][0]["id"] == identity
    assert path.read_bytes() == original


def test_sibling_marker_removal_restarts_album_clock_and_preserves_audio_signature(settings):
    intake = setup(settings)
    configure(intake)
    (settings.music_dir / "Album").mkdir()
    source(settings, "Album/01.flac")
    marker = settings.music_dir / "Album/02.flac.part"
    marker.write_bytes(b"incomplete")
    assert not intake.has_work()
    item = intake.items()["items"][0]
    signature = intake.item(item["id"])["signature"]
    age(intake)
    assert not intake.has_work()
    assert import_music(settings)["counts"]["waiting"] == 1
    marker.unlink()
    assert not intake.has_work()
    assert intake.item(item["id"])["signature"] == signature
    age(intake)
    assert intake.has_work()
    assert import_music(settings, automatic=True)["counts"]["copied"] == 1
    assert intake.item(item["id"])["version"] == item["version"]


def test_multidisc_group_does_not_block_another_album(settings):
    intake = setup(settings)
    for folder in ["First/CD01", "First/CD02", "Second"]:
        (settings.music_dir / folder).mkdir(parents=True)
    source(settings, "First/CD01/01.flac")
    source(settings, "Second/01.flac")
    (settings.music_dir / "First/CD02/02.flac.part").write_bytes(b"incomplete")
    report = import_music(settings)
    assert report["counts"]["copied"] == 1
    assert report["counts"]["waiting"] == 1
    assert [i["source_path"] for i in intake.items()["items"]] == ["First/CD01/01.flac"]


def test_approved_intake_cannot_publish_while_download_incomplete(settings):
    intake = setup(settings)
    configure(intake)
    source(settings, complete=False)
    import_music(settings)
    item = intake.items()["items"][0]
    intake.approve(
        item["id"],
        IntakeApproval(
            version=item["version"],
            overrides={"title": "Song", "artists": ["Artist"], "album": "Album"},
        ),
    )
    marker = settings.music_dir / "another.flac.part"
    marker.write_bytes(b"incomplete")
    assert import_music(settings, automatic=True)["counts"]["waiting"] == 1
    assert intake.item(item["id"])["state"] == "approved"
    marker.unlink()
    assert import_music(settings, automatic=True)["counts"]["copied"] == 0
    age(intake)
    assert import_music(settings, automatic=True)["counts"]["copied"] == 1


def test_custom_markers_old_client_preserves_policy_and_v21_migration(settings):
    from migration_support import pre22

    intake = setup(settings)
    source(settings)
    configure(intake, partial_suffixes=[".DOWNLOADING"], wait_for_album=False)
    previous = intake.preferences()
    intake.configure(
        IntakeSettings(**{k: v for k, v in previous.items() if k != "download_policy"})
    )
    assert intake.preferences()["download_policy"] == {
        "partial_suffixes": [".downloading"],
        "wait_for_album": False,
    }
    assert import_music(settings)["counts"]["copied"] == 1
    track = intake.repository.tracks()["items"][0]
    with intake.database.connect(write=True) as db:
        before = dict(db.execute("SELECT * FROM intake_items").fetchone())
        pre22(db)
        db.execute("PRAGMA user_version=21")
    Database(settings.data_dir).initialize()
    with intake.database.connect() as db:
        assert dict(db.execute("SELECT * FROM intake_items").fetchone()) == before
        assert db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    assert intake.repository.tracks()["items"][0]["id"] == track["id"]
    assert intake.preferences()["download_policy"]["wait_for_album"] is True
    assert intake.preferences()["enabled"] is True


@pytest.mark.parametrize("suffixes", [[".flac/part"], ["part"], ["."], [".a"] * 17, []])
def test_invalid_suffix_policy_is_rejected(suffixes):
    from pydantic import ValidationError

    from wildstring.library.download_policy import DownloadPolicy

    with pytest.raises(ValidationError):
        DownloadPolicy(partial_suffixes=suffixes)


def test_loose_track_is_not_blocked_by_an_unrelated_nested_download(settings):
    intake = setup(settings)
    source(settings)
    (settings.music_dir / "Other Album").mkdir()
    (settings.music_dir / "Other Album/song.flac.part").write_bytes(b"incomplete")
    assert import_music(settings)["counts"]["copied"] == 1
    assert intake.repository.tracks()["total"] == 1


def test_disc_directory_markers_at_import_root_block_the_same_multidisc_album(settings):
    intake = setup(settings)
    (settings.music_dir / "CD01").mkdir()
    (settings.music_dir / "CD02.part").mkdir()
    source(settings, "CD01/song.flac")
    assert import_music(settings)["counts"]["waiting"] == 1
    assert intake.repository.tracks()["total"] == 0
