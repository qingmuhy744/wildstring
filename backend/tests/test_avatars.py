"""Real uploads exercise private account ownership and image normalization."""

import io

import pytest
from PIL import Image
from test_auth import CLIENT

BASE = "/api/v1/auth/avatar"


def picture(color="red", format="PNG"):
    output = io.BytesIO()
    image = Image.new("RGB", (80, 40), color)
    exif = Image.Exif()
    exif[270] = "private-camera-note"
    exif[274] = 6
    image.save(output, format=format, exif=exif)
    return output.getvalue()


@pytest.mark.parametrize("format", ["JPEG", "PNG", "WEBP"])
def test_avatar_normalizes_and_removes_image_metadata(settings, authenticated_client, format):
    with authenticated_client(settings) as client:
        assert client.get(BASE + "/info").json() == {"version": None}
        assert client.post(BASE, content=picture(format=format)).status_code == 403
        result = client.post(BASE, headers=CLIENT, content=picture(format=format))
        assert result.status_code == 200, result.text
        assert len(result.json()["version"]) == 64
        response = client.get(BASE)
        assert response.headers["content-type"] == "image/jpeg"
        assert response.headers["cache-control"] == "private, no-store"
        assert response.headers["x-content-type-options"] == "nosniff"
        with Image.open(io.BytesIO(response.content)) as decoded:
            assert decoded.size == (256, 256)
            assert not decoded.getexif()
        assert b"private-camera-note" not in response.content
        assert len(list((settings.data_dir / "avatars").iterdir())) == 1


def test_avatar_rejects_invalid_or_large_upload_without_replacing_current(
    settings, authenticated_client, monkeypatch
):
    with authenticated_client(settings) as client:
        client.post(BASE, headers=CLIENT, content=picture())
        before = client.get(BASE).content
        for content in (b"private-invalid-file", b'<svg xmlns="http://www.w3.org/2000/svg"/>'):
            response = client.post(BASE, headers=CLIENT, content=content)
            assert response.status_code == 422 and response.json()["detail"] == "invalid_avatar"
            assert "private-invalid" not in response.text
        assert (
            client.post(BASE, headers=CLIENT, content=b"x" * (5 * 1024 * 1024 + 1)).status_code
            == 413
        )
        monkeypatch.setattr("wildstring.avatars.MAX_PIXELS", 100)
        assert client.post(BASE, headers=CLIENT, content=picture()).status_code == 422
        assert client.get(BASE).content == before
        forbidden = client.delete(BASE)
        assert forbidden.status_code == 403


def test_avatar_persists_and_isolated_users_cannot_read_or_remove_each_others_picture(
    settings, authenticated_client
):
    password = "synthetic-avatar-password"
    with authenticated_client(settings) as client:
        first = client.post(BASE, headers=CLIENT, content=picture()).json()
        original = client.get(BASE).content
        assert (
            client.post(
                "/api/v1/manage/users",
                headers=CLIENT,
                json={"username": "avatar-user", "password": password},
            ).status_code
            == 201
        )
        assert (
            client.post(
                "/api/v1/auth/login",
                headers=CLIENT,
                json={"username": "avatar-user", "password": password},
            ).status_code
            == 200
        )
        assert client.get(BASE + "/info").json() == {"version": None}
        assert client.get(BASE + "?user_id=admin").status_code == 404
        assert client.get(BASE + "?account=admin").status_code == 409
        stale = client.delete(BASE, headers=CLIENT | {"X-Wildstring-Account": "admin"})
        assert stale.status_code == 409
        reset = client.delete(BASE, headers=CLIENT)
        assert reset.status_code == 204
        assert client.post(BASE, headers=CLIENT, content=picture("blue")).json() != first
    with authenticated_client(settings) as client:
        assert client.get(BASE + "/info").json() == first
        assert client.get(BASE).content == original
        reset = client.delete(BASE, headers=CLIENT)
        assert reset.status_code == 204
        assert client.get(BASE).status_code == 404
        client.post("/api/v1/auth/logout", headers=CLIENT)
        assert client.get(BASE + "/info").status_code == 401
        assert client.get(BASE).status_code == 401
        assert client.post(BASE, headers=CLIENT, content=picture()).status_code == 401
