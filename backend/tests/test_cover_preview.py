"""Candidate covers use the server proxy and cannot apply metadata during a preview."""

import hashlib
import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from test_assets import image
from test_personal_library import music
from test_providers import RECORDING, enable
from test_users import login, new_user

from wildstring.database import Database
from wildstring.library.edits import MetadataEditor
from wildstring.library.repository import LibraryRepository
from wildstring.library.scanner import scan_library
from wildstring.main import create_app


def suggestion(client):
    providers = client.app.state.providers
    providers.stop()
    providers.exit.clear()
    assert enable(client, auto_new=False).status_code == 200
    track = client.get("/api/v1/tracks").json()["items"][0]
    url = f"https://coverartarchive.org/release/{RECORDING}/12345.jpg"
    providers.suggestions = lambda _, **_kwargs: (
        [
            (
                "musicbrainz",
                f"https://musicbrainz.org/recording/{RECORDING}",
                {"title": "封面候选"},
                url,
                {},
            )
        ],
        [],
    )
    providers.enqueue([track["id"]])
    providers.step()
    candidate = client.get(f"/api/v1/manage/providers/tracks/{track['id']}").json()["suggestions"][
        0
    ]
    return providers, track, candidate, url


def test_cover_preview_uses_private_proxy_and_does_not_apply_or_modify_audio(
    settings, authenticated_client, monkeypatch
):
    path = music(settings, "preview.flac", ["A"], ["A"])
    scan_library(settings)
    original = hashlib.sha256(path.read_bytes()).digest()
    with authenticated_client(settings) as client:
        providers, track, candidate, url = suggestion(client)
        proxy = "http://fixture:private-proxy@127.0.0.1:7890"
        assert (
            enable(client, proxy_mode="custom", proxy_url=proxy, auto_new=False).status_code == 200
        )
        calls = []

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                pass

            def read(self, limit):
                assert limit == 8 * 1024 * 1024 + 1
                return image("red")

        class Opener:
            def open(self, request, timeout):
                calls.append((request.full_url, timeout))
                return Response()

        def build(handler, *_):
            assert handler.proxies == {"http": proxy, "https": proxy}
            return Opener()

        monkeypatch.setattr("wildstring.providers.build_opener", build)
        repository = LibraryRepository(Database(settings.data_dir), settings.library_dir)
        before = MetadataEditor(repository).read(track["id"])
        endpoint = f"/api/v1/manage/providers/suggestions/{candidate['id']}/cover-preview"
        response = client.get(endpoint)
        assert response.status_code == 200 and response.headers["content-type"] == "image/jpeg"
        assert response.headers["cache-control"] == "private, no-store"
        assert (
            response.headers["vary"] == "Cookie"
            and response.headers["x-content-type-options"] == "nosniff"
        )
        with Image.open(io.BytesIO(response.content)) as picture:
            assert picture.format == "JPEG" and max(picture.size) <= 768
        assert calls == [(url, 15)]
        assert MetadataEditor(repository).read(track["id"]) == before
        with repository.database.connect() as connection:
            assert connection.execute("SELECT count(*) FROM artwork_choices").fetchone()[0] == 0
            row = connection.execute(
                "SELECT status FROM metadata_suggestions WHERE id=?", (candidate["id"],)
            ).fetchone()
            assert row["status"] == "pending"
        assert client.get(f"/api/v1/tracks/{track['id']}").json()["has_cover"] is False
        new_user(client)
        with TestClient(create_app(settings)) as ordinary:
            assert ordinary.get(endpoint).status_code == 401
            assert login(ordinary).status_code == 200
            assert ordinary.get(endpoint).status_code == 403
        assert len(calls) == 1
    assert hashlib.sha256(path.read_bytes()).digest() == original


@pytest.mark.parametrize(
    "bad_url",
    [
        "https://evil.example/release/x/123.jpg",
        f"https://coverartarchive.org:invalid/release/{RECORDING}/123.jpg",
        f"https://private:secret@coverartarchive.org/release/{RECORDING}/123.jpg",
        f"https://coverartarchive.org/release/{RECORDING}/123.jpg?token=private",
    ],
)
def test_cover_preview_rejects_untrusted_addresses_without_network(
    settings, authenticated_client, bad_url
):
    music(settings, "preview.flac", ["A"], ["A"])
    scan_library(settings)
    with authenticated_client(settings) as client:
        providers, _, candidate, _ = suggestion(client)
        providers.request = lambda *_a, **_k: pytest.fail(
            "Untrusted cover URL must not be requested"
        )
        with Database(settings.data_dir).connect(write=True) as connection:
            connection.execute(
                "UPDATE metadata_suggestions SET cover_url=? WHERE id=?", (bad_url, candidate["id"])
            )
        response = client.get(
            f"/api/v1/manage/providers/suggestions/{candidate['id']}/cover-preview"
        )
        assert response.status_code == 422 and response.json()["detail"] == "invalid_cover_url"
        assert "secret" not in response.text and "token" not in response.text


def test_cover_preview_scope_missing_and_invalid_image(settings, authenticated_client, tmp_path):
    music(settings, "preview.flac", ["A"], ["A"])
    scan_library(settings)
    with authenticated_client(settings) as client:
        providers, track, candidate, url = suggestion(client)
        endpoint = f"/api/v1/manage/providers/suggestions/{candidate['id']}/cover-preview"
        providers.request = lambda *_a, **_k: b"not an image"
        assert client.get(endpoint).status_code == 502
        assert (
            client.get("/api/v1/manage/providers/suggestions/unknown/cover-preview").status_code
            == 404
        )
        with Database(settings.data_dir).connect(write=True) as connection:
            connection.execute(
                "UPDATE metadata_suggestions SET cover_url=NULL WHERE id=?", (candidate["id"],)
            )
        assert client.get(endpoint).status_code == 404
        other = tmp_path / "other-library"
        other.mkdir()
        library_id = LibraryRepository(Database(settings.data_dir), other).library_id(create=True)
        with Database(settings.data_dir).connect(write=True) as connection:
            connection.execute(
                "UPDATE metadata_suggestions SET cover_url=? WHERE id=?", (url, candidate["id"])
            )
            connection.execute(
                "UPDATE tracks SET library_id=? WHERE id=?", (library_id, track["id"])
            )
        assert client.get(endpoint).status_code == 404
