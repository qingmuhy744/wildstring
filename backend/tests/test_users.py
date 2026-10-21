"""Real multi-session role checks, personal data isolation and password revocation."""

import shutil
from uuid import uuid4

from fastapi.testclient import TestClient
from test_personal_library import HEADERS, create_playlist, music

from wildstring.auth import COOKIE
from wildstring.database import Database
from wildstring.library.scanner import scan_library
from wildstring.main import create_app

PASSWORD = "ordinary-test-password"


def new_user(admin, username="listener", role="user"):
    response = admin.post(
        "/api/v1/manage/users",
        headers=HEADERS,
        json={"username": username, "password": PASSWORD, "role": role},
    )
    assert response.status_code == 201, response.text
    assert "password" not in response.text
    return response.json()


def login(client, username="listener", password=PASSWORD):
    return client.post(
        "/api/v1/auth/login", headers=HEADERS, json={"username": username, "password": password}
    )


def test_roles_and_private_collections_in_every_track_view(settings, authenticated_client):
    music(settings, "shared.flac", ["乐队"], ["乐队"])
    scan_library(settings)
    with authenticated_client(settings) as admin:
        account = new_user(admin)
        track = admin.get("/api/v1/tracks").json()["items"][0]
        private = create_playlist(admin, "管理员私藏")
        assert (
            admin.put(
                f"/api/v1/tracks/{track['id']}/favorite", headers=HEADERS, json={"loved": True}
            ).status_code
            == 200
        )
        session = str(uuid4())
        report = {"session_id": session, "track_id": track["id"], "listened_ms": 1000}
        assert admin.post("/api/v1/listening", headers=HEADERS, json=report).status_code == 200
        with TestClient(create_app(settings)) as user:
            assert login(user, "LISTENER").status_code == 200
            assert user.get("/api/v1/auth/status").json()["user"]["role"] == "user"
            for path in [
                "/api/v1/manage/overview",
                "/api/v1/manage/users",
                "/api/v1/manage/access",
                f"/api/v1/manage/tracks/{track['id']}/lyrics",
                "/api/v1/scans",
                "/api/v1/imports",
            ]:
                assert user.get(path).status_code == 403, path
            assert (
                user.post(
                    "/api/v1/manage/users",
                    headers=HEADERS,
                    json={"username": "escape", "password": PASSWORD, "role": "admin"},
                ).status_code
                == 403
            )
            assert (
                user.put(
                    f"/api/v1/manage/tracks/{track['id']}/metadata",
                    headers=HEADERS,
                    json={"version": 1, "overrides": {"title": "tamper"}},
                ).status_code
                == 403
            )
            assert (
                user.get(
                    f"/api/v1/tracks/{track['id']}/stream", headers={"Range": "bytes=0-31"}
                ).status_code
                == 206
            )
            artist = user.get("/api/v1/artists").json()["items"][0]
            for path in [
                "/api/v1/tracks",
                f"/api/v1/albums/{track['album_id']}/tracks",
                f"/api/v1/artists/{artist['id']}/tracks",
            ]:
                current = user.get(path).json()["items"][0]
                assert (
                    not current["loved"]
                    and current["play_count"] == 0
                    and current["listened_ms"] == 0
                )
            assert user.get("/api/v1/favorites/ids").json() == {"ids": []}
            assert user.get("/api/v1/listening/summary").json()["listened_ms"] == 0
            lists = user.get("/api/v1/playlists").json()["items"]
            assert len(lists) == 1 and lists[0]["kind"] == "favorites"
            assert lists[0]["id"] != admin.get("/api/v1/playlists").json()["items"][0]["id"]
            assert user.get(f"/api/v1/playlists/{private['id']}").status_code == 404
            assert user.get(f"/api/v1/playlists/{private['id']}/tracks").status_code == 404
            deletion_response = user.delete(
                f"/api/v1/playlists/{private['id']}?version=1", headers=HEADERS
            )
            assert deletion_response.status_code == 404
            assert user.post("/api/v1/listening", headers=HEADERS, json=report).status_code == 409
            assert (
                user.put(
                    f"/api/v1/tracks/{track['id']}/favorite", headers=HEADERS, json={"loved": True}
                ).status_code
                == 200
            )
            smart = create_playlist(user, "自己的收藏规则", {"all": [{"is": {"loved": True}}]})
            assert smart["track_count"] == 1
            assert admin.get(f"/api/v1/playlists/{smart['id']}").status_code == 404
            report["session_id"] = str(uuid4())
            assert user.post("/api/v1/listening", headers=HEADERS, json=report).status_code == 200
            assert user.get("/api/v1/tracks").json()["items"][0]["listened_ms"] == 1000
        assert admin.get("/api/v1/tracks").json()["items"][0]["listened_ms"] == 1000
        assert account["enabled"]


def test_password_reset_self_change_disable_and_admin_self_change(settings, authenticated_client):
    with authenticated_client(settings) as admin:
        account = new_user(admin)
        endpoint = f"/api/v1/manage/users/{account['id']}"
        with TestClient(create_app(settings)) as user:
            assert login(user).status_code == 200
            old_token = user.cookies[COOKIE]
            reset = {"version": account["version"], "new_password": "replacement-password"}
            assert (
                admin.post(endpoint + "/password", headers=HEADERS, json=reset).status_code == 204
            )
            assert user.get("/api/v1/tracks").status_code == 401
            assert login(user).status_code == 401
            assert login(user, password="replacement-password").status_code == 200
            body = {
                "current_password": "incorrect-password",
                "new_password": "self-changed-password",
            }
            assert user.post("/api/v1/auth/password", headers=HEADERS, json=body).status_code == 400
            assert user.get("/api/v1/tracks").status_code == 200
            body["current_password"] = "replacement-password"
            assert user.post("/api/v1/auth/password", json=body).status_code == 403
            assert user.post("/api/v1/auth/password", headers=HEADERS, json=body).status_code == 204
            user.cookies.set(COOKIE, old_token)
            assert user.get("/api/v1/tracks").status_code == 401
            user.cookies.clear()
            assert login(user, password="self-changed-password").status_code == 200
            current = next(
                item
                for item in admin.get("/api/v1/manage/users").json()["items"]
                if item["id"] == account["id"]
            )
            disabled = admin.put(
                endpoint,
                headers=HEADERS,
                json={"version": current["version"], "role": "user", "enabled": False},
            )
            assert disabled.status_code == 200
            assert user.get("/api/v1/tracks").status_code == 401
            assert login(user, password="self-changed-password").status_code == 401
            assert (
                admin.put(
                    endpoint,
                    headers=HEADERS,
                    json={"version": current["version"], "role": "user", "enabled": True},
                ).status_code
                == 409
            )
        self = admin.get("/api/v1/auth/status").json()["user"]
        assert (
            admin.put(
                "/api/v1/manage/users/admin",
                headers=HEADERS,
                json={"version": self["version"], "role": "user", "enabled": False},
            ).status_code
            == 409
        )
        assert (
            admin.post(
                "/api/v1/manage/users/admin/password",
                headers=HEADERS,
                json={"version": self["version"], "new_password": "new-admin-password"},
            ).status_code
            == 409
        )
        assert (
            admin.post(
                "/api/v1/auth/password",
                headers=HEADERS,
                json={
                    "current_password": "test-admin-password-123",
                    "new_password": "new-admin-password",
                },
            ).status_code
            == 204
        )
        assert admin.get("/api/v1/tracks").status_code == 401
        assert login(admin, "admin", "new-admin-password").status_code == 200


def test_account_validation_secrets_and_no_self_promotion(settings, authenticated_client):
    with authenticated_client(settings) as admin:
        new_user(admin, "Listener")
        assert (
            admin.post(
                "/api/v1/manage/users",
                headers=HEADERS,
                json={"username": "listener", "password": PASSWORD},
            ).status_code
            == 409
        )
        for body in [
            {"username": "../bad", "password": PASSWORD},
            {"username": "valid", "password": "short"},
            {"username": "valid", "password": PASSWORD, "role": "superuser"},
        ]:
            response = admin.post("/api/v1/manage/users", headers=HEADERS, json=body)
            assert response.status_code == 422 and body["password"] not in response.text
        with Database(settings.data_dir).connect() as connection:
            assert (
                PASSWORD
                not in connection.execute(
                    "SELECT password_hash FROM users WHERE username='Listener'"
                ).fetchone()[0]
            )


def test_profiles_source_browser_and_safe_album_trash(settings, authenticated_client):
    settings.music_dir.mkdir()
    music(settings, "库内.flac", ["曲库艺人"], ["曲库艺人"], album="待替换专辑")
    shutil.copyfile(settings.library_dir / "库内.flac", settings.music_dir / "库内.flac")
    (settings.music_dir / "未完成.flac.part").write_bytes(b"partial")
    scan_library(settings)
    with authenticated_client(settings) as admin:
        created = admin.post(
            "/api/v1/manage/users",
            headers=HEADERS,
            json={
                "username": "librarian",
                "password": "librarian-password-123",
                "profile": "librarian",
            },
        )
        assert created.status_code == 201, created.text
        assert created.json()["profile"] == "librarian"
        for username, profile in (("editor", "editor"), ("listener", "listener")):
            response = admin.post(
                "/api/v1/manage/users",
                headers=HEADERS,
                json={
                    "username": username,
                    "password": f"{username}-password-123",
                    "profile": profile,
                },
            )
            assert response.status_code == 201, response.text
        track = admin.get("/api/v1/tracks").json()["items"][0]
        album_id = track["album_id"]
        assert admin.get("/api/v1/manage/library/sources").status_code == 200
        folders = admin.get("/api/v1/manage/library/folders").json()["items"]
        assert any(item["name"] == "未完成.flac.part" and item["pending"] for item in folders)
        assert (
            admin.post(
                "/api/v1/manage/library/import/preview",
                headers=HEADERS,
                json={"source_id": "import", "path": "."},
            ).json()["count"]
            == 1
        )
        assert (
            admin.post(f"/api/v1/manage/albums/{album_id}/trash", headers=HEADERS).status_code
            == 202
        )
        assert admin.get("/api/v1/tracks").json()["total"] == 0
        trash = admin.get("/api/v1/manage/library/trash").json()["items"]
        assert len(trash) == 1 and trash[0]["status"] == "trashed"
        identity = trash[0]["id"]
        assert (
            admin.post(
                f"/api/v1/manage/library/trash/{identity}/restore", headers=HEADERS
            ).status_code
            == 200
        )
        assert admin.get("/api/v1/tracks").json()["total"] == 1

    with TestClient(create_app(settings)) as librarian:
        assert login(librarian, "librarian", "librarian-password-123").status_code == 200
        assert librarian.get("/api/v1/manage/overview").status_code == 200
        assert librarian.get("/api/v1/manage/ai").status_code == 403
        assert librarian.get("/api/v1/manage/library/sources").status_code == 200
        assert (
            librarian.delete(
                f"/api/v1/manage/library/trash/{identity}", headers=HEADERS
            ).status_code
            == 403
        )
    with TestClient(create_app(settings)) as editor:
        assert login(editor, "editor", "editor-password-123").status_code == 200
        assert editor.get("/api/v1/manage/metadata/folders").status_code == 200
        assert editor.get("/api/v1/manage/ai").status_code == 403
    with TestClient(create_app(settings)) as listener:
        assert login(listener, "listener", "listener-password-123").status_code == 200
        assert listener.get("/api/v1/manage/overview").status_code == 403


def test_v7_upgrade_preserves_password_cookie_ids_and_existing_personal_data(
    settings, authenticated_client
):
    from conftest import restore_v7_account_layout

    music(settings, "existing.flac", ["原来的艺人"], ["原来的艺人"])
    scan_library(settings)
    with authenticated_client(settings) as admin:
        token = admin.cookies[COOKIE]
        track = admin.get("/api/v1/tracks").json()["items"][0]
        playlist = create_playlist(admin, "已有歌单")
        assert (
            admin.post(
                f"/api/v1/playlists/{playlist['id']}/tracks",
                headers=HEADERS,
                json={"version": playlist["version"], "track_ids": [track["id"]]},
            ).status_code
            == 200
        )
    database = Database(settings.data_dir)
    with database.connect(write=True) as connection:
        restore_v7_account_layout(connection)
        connection.execute(
            "UPDATE tracks SET loved=1,loved_at='2026-10-15',play_count=9,listened_ms=12345,last_played_at='2026-10-15'"
        )
        from migration_support import pre18

        pre18(connection)
        connection.execute("PRAGMA user_version=7")
    database.initialize()
    with TestClient(create_app(settings)) as client:
        client.cookies.set(COOKIE, token)
        assert client.get("/api/v1/auth/status").json()["user"]["id"] == "admin"
        existing = client.get("/api/v1/tracks").json()["items"][0]
        assert (
            existing["id"] == track["id"]
            and existing["loved"]
            and existing["play_count"] == 9
            and existing["listened_ms"] == 12345
        )
        assert (
            client.get(f"/api/v1/playlists/{playlist['id']}/tracks").json()["items"][0]["id"]
            == track["id"]
        )
        assert login(client, "admin", "test-admin-password-123").status_code == 200
