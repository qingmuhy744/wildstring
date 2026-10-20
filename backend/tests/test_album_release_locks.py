"""Album release locks prevent cross-release automatic metadata changes."""

import shutil

from mutagen.flac import FLAC
from test_albums import FIXTURES
from test_personal_library import HEADERS

from wildstring.database import Database
from wildstring.library.inspection import InspectionIndex
from wildstring.library.repository import LibraryRepository
from wildstring.library.scanner import scan_library


def music(settings, relative, album, title, number):
    path = settings.library_dir / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(FIXTURES / "silence.flac", path)
    tags = FLAC(path)
    tags["album"] = album
    tags["title"] = title
    tags["artist"] = "GALA"
    tags["tracknumber"] = str(number)
    tags.save()
    return path


def test_release_lock_round_trip_and_split_warning(settings, authenticated_client):
    first = music(settings, "release/01.flac", "2的奉献--GALA爱爱爱新年音乐会Vol.1", "一", 1)
    second = music(
        settings,
        "release/02.flac",
        "2的奉献-GALA 爱爱爱新年音乐会, Vol. 1",
        "二",
        2,
    )
    scan_library(settings)
    repository = LibraryRepository(Database(settings.data_dir), settings.library_dir)
    albums = repository.albums(limit=10)["items"]
    assert len(albums) == 2
    with authenticated_client(settings) as client:
        locked = client.get(f"/api/v1/manage/albums/{albums[0]['id']}/release-lock")
        assert locked.status_code == 200 and locked.json()["locked"] is False
        saved = client.put(
            f"/api/v1/manage/albums/{albums[0]['id']}/release-lock",
            headers=HEADERS,
            json={
                "provider": "qqmusic",
                "release_id": "002InDza0VPJEH",
                "source_url": "https://y.qq.com/n/ryqq/songDetail/example",
                "snapshot": {"title": albums[0]["title"], "track_count": 1},
            },
        )
        assert saved.status_code == 200
        assert saved.json()["locked"] is True
        assert saved.json()["version"] == 1
        assert (
            client.get(f"/api/v1/manage/albums/{albums[0]['id']}/release-lock").json()["release_id"]
            == "002InDza0VPJEH"
        )

    index = InspectionIndex(repository)
    track = repository.track(repository.tracks(limit=10)["items"][0]["id"])
    with repository.database.connect() as connection:
        track["metadata_version"] = connection.execute(
            "SELECT version FROM track_metadata WHERE track_id=?", (track["id"],)
        ).fetchone()[0]
    findings = index.findings(track, has_lyrics=True)
    assert any(finding["code"] == "possible_album_split" for finding in findings)
    assert first.exists() and second.exists()


def test_release_lock_can_be_cleared_with_version(settings, authenticated_client):
    music(settings, "release/01.flac", "专辑", "一", 1)
    scan_library(settings)
    repository = LibraryRepository(Database(settings.data_dir), settings.library_dir)
    album_id = repository.albums(limit=1)["items"][0]["id"]
    with authenticated_client(settings) as client:
        assert (
            client.put(
                f"/api/v1/manage/albums/{album_id}/release-lock",
                headers=HEADERS,
                json={"provider": "musicbrainz", "release_id": "release-1"},
            ).status_code
            == 200
        )
        cleared = client.delete(
            f"/api/v1/manage/albums/{album_id}/release-lock?version=1", headers=HEADERS
        ).json()
        assert cleared == {"album_id": album_id, "cleared": True}
        current = client.get(f"/api/v1/manage/albums/{album_id}/release-lock").json()
        assert current == {
            "album_id": album_id,
            "locked": False,
        }
