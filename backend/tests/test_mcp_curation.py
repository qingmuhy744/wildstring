"""Real scoped MCP proposals: fixed images, atomic albums and evidence-only rules."""

import hashlib
import io

import pytest
from fastapi import HTTPException
from mutagen.flac import FLAC
from PIL import Image
from test_assets import image
from test_cover_preview import suggestion
from test_mcp_http import rpc
from test_mcp_music import BASE, create_token, result, tool
from test_personal_library import HEADERS, music

from wildstring.agent_platform import AgentPlatform
from wildstring.agent_sources import evidence_url
from wildstring.library.edits import MetadataEditor, MetadataUpdate, Overrides
from wildstring.library.scanner import scan_library
from wildstring.providers import Providers


@pytest.fixture
def curation(settings, authenticated_client, monkeypatch):
    monkeypatch.setattr(Providers, "start", lambda self: None)
    monkeypatch.setattr(AgentPlatform, "start", lambda self: None)
    paths = [music(settings, f"song-{n}.flac", ["Band"], ["Band"], number=n) for n in (1, 2)]
    scan_library(settings)
    hashes = [hashlib.sha256(path.read_bytes()).hexdigest() for path in paths]
    with authenticated_client(settings) as api:
        token = create_token(
            api, ["library:read", "library:manage", "drafts:write", "drafts:apply", "tasks:write"]
        )
        api.app.state.agent_platform.transport = lambda *a, **kw: pytest.fail("No implicit AI call")
        yield api, token, api.app.state.agent_platform
    assert [hashlib.sha256(path.read_bytes()).hexdigest() for path in paths] == hashes


def batch(api, token, album_id, changes):
    page = result(api, token, "get_album_tracks", {"album_id": album_id})
    return result(
        api,
        token,
        "create_draft",
        {
            "kind": "metadata_batch",
            "title": "Reviewed album",
            "payload": {
                "album_ids": [album_id],
                "items": [
                    {
                        "track_id": t["id"],
                        "metadata_version": t["metadata_version"],
                        "overrides": changes,
                    }
                    for t in page["items"]
                ],
            },
        },
    )


def approve(api, draft):
    response = api.post(
        BASE + f"/drafts/{draft['id']}/approve",
        headers=HEADERS,
        json={"version": draft["version"], "preview_digest": draft.get("preview_digest")},
    )
    assert response.status_code == 200, response.text


def apply_args(draft):
    return {
        "draft_id": draft["id"],
        "version": draft["version"],
        "idempotency_key": "curation-" + draft["id"],
    }


def test_album_batch_rolls_back_every_write_preserves_other_overrides_and_replays_once(
    curation, monkeypatch
):
    api, token, service = curation
    album = result(api, token, "search_albums")["items"][0]
    tracks = result(api, token, "get_album_tracks", {"album_id": album["id"]})["items"]
    editor = MetadataEditor(service.repository)
    editor.save(
        tracks[0]["id"], MetadataUpdate(version=1, overrides=Overrides(composers=["Kept composer"]))
    )
    draft = batch(api, token, album["id"], {"album": "New album", "album_artists": ["Band"]})
    assert len(draft["before"]["items"]) == 2
    assert tool(api, token, "apply_draft", apply_args(draft)).status_code == 409
    assert (
        api.post(
            BASE + f"/drafts/{draft['id']}/approve",
            headers=HEADERS,
            json={"version": draft["version"]},
        ).json()["detail"]
        == "draft_preview_required"
    )
    approve(api, draft)
    original = MetadataEditor.save_in_transaction
    visited = []

    def fail_on_second(self, db, identity, body, **kwargs):
        original(self, db, identity, body, **kwargs)
        visited.append(identity)
        if len(visited) == 2:
            raise HTTPException(409, "synthetic_batch_failure")

    with monkeypatch.context() as patch:
        patch.setattr(MetadataEditor, "save_in_transaction", fail_on_second)
        assert tool(api, token, "apply_draft", apply_args(draft)).status_code == 409
    assert len(visited) == 2
    for item in draft["payload"]["items"]:
        current = editor.read(item["track_id"])
        assert current["version"] == item["metadata_version"]
        assert current["effective"]["album"] == album["title"]
    with service.database.connect() as db:
        assert db.execute("SELECT count(*) FROM agent_audit").fetchone()[0] == 0
    saved = result(api, token, "apply_draft", apply_args(draft))
    assert saved["status"] == "applied"
    assert result(api, token, "apply_draft", apply_args(draft)) == saved
    assert editor.read(tracks[0]["id"])["effective"]["composers"] == ["Kept composer"]
    assert result(api, token, "search_albums")["items"][0]["title"] == "New album"
    with service.database.connect() as db:
        assert (
            db.execute(
                "SELECT count(*) FROM agent_audit WHERE draft_id=?", (draft["id"],)
            ).fetchone()[0]
            == 2
        )


@pytest.mark.parametrize("mutation", ["version", "membership"])
def test_album_batch_rejects_stale_row_or_changed_album_selection(curation, settings, mutation):
    api, token, service = curation
    album = result(api, token, "search_albums")["items"][0]
    draft = batch(api, token, album["id"], {"album_artists": ["New artist"]})
    approve(api, draft)
    if mutation == "version":
        target = draft["payload"]["items"][-1]
        MetadataEditor(service.repository).save(
            target["track_id"],
            MetadataUpdate(
                version=target["metadata_version"], overrides=Overrides(title="User edit")
            ),
        )
    else:
        music(settings, "added.flac", ["Band"], ["Band"], number=3)
        scan_library(settings)
    response = tool(api, token, "apply_draft", apply_args(draft))
    assert response.status_code == 409
    assert response.json()["detail"] == (
        "metadata_version_conflict" if mutation == "version" else "album_membership_changed"
    )
    assert result(api, token, "get_draft", {"draft_id": draft["id"]})["status"] == "approved"
    assert all(t["album_artists"] == ["Band"] for t in result(api, token, "search_tracks")["items"])


def cover_draft(api, token, monkeypatch):
    providers, track, candidate, _ = suggestion(api)
    monkeypatch.setattr(providers, "request", lambda *a, **kw: image("red"))
    selected = result(api, token, "get_cover_candidates", {"track_id": track["id"]})["items"][0]
    assert selected["id"] == candidate["id"] and not selected["stale"]
    draft = result(
        api,
        token,
        "create_draft",
        {
            "kind": "cover",
            "title": "Fixed cover",
            "payload": {
                "suggestion_id": candidate["id"],
                "metadata_version": track.get("metadata_version", 1),
            },
        },
    )
    return providers, track, candidate, draft


def test_cover_mcp_returns_image_and_application_uses_approved_snapshot(curation, monkeypatch):
    api, token, service = curation
    providers, track, candidate, draft = cover_draft(api, token, monkeypatch)
    mcp = rpc(
        api,
        token["Authorization"][7:],
        "tools/call",
        {"name": "get_cover_preview", "arguments": {"suggestion_id": candidate["id"]}},
    ).json()["result"]
    assert not mcp.get("isError") and mcp["content"][1]["type"] == "image"
    assert mcp["content"][1]["mimeType"] == "image/jpeg"
    assert "image" not in mcp["structuredContent"]["result"]
    monkeypatch.setattr(
        providers, "request", lambda *a, **kw: pytest.fail("Snapshot must not be downloaded again")
    )
    endpoint = BASE + f"/drafts/{draft['id']}/cover-preview"
    preview = api.get(endpoint)
    assert preview.status_code == 200 and preview.headers["cache-control"] == "private, no-store"
    assert preview.headers["x-content-type-options"] == "nosniff"
    with Image.open(io.BytesIO(preview.content)) as picture:
        assert picture.getpixel((0, 0))[0] > 200
    assert not result(api, token, "get_track", {"track_id": track["id"]})["has_cover"]
    # Even a scoped token cannot approve by spoofing the UI header.
    cookies = dict(api.cookies)
    api.cookies.clear()
    assert (
        api.post(
            BASE + f"/drafts/{draft['id']}/approve", headers=token | HEADERS, json={"version": 1}
        ).status_code
        == 401
    )
    assert api.get(endpoint, headers=token).status_code == 401
    api.cookies.update(cookies)
    approve(api, draft)
    saved = result(api, token, "apply_draft", apply_args(draft))
    assert saved["result"]["image_sha256"] == draft["payload"]["image_sha256"]
    assert result(api, token, "get_track", {"track_id": track["id"]})["has_cover"]
    assert result(api, token, "apply_draft", apply_args(draft)) == saved


@pytest.mark.parametrize("mutation", ["candidate", "image", "version"])
def test_cover_rejects_candidate_tamper_missing_snapshot_or_new_metadata(
    curation, monkeypatch, mutation
):
    api, token, service = curation
    _, track, candidate, draft = cover_draft(api, token, monkeypatch)
    approve(api, draft)
    if mutation == "candidate":
        with service.database.connect(write=True) as db:
            db.execute(
                "UPDATE metadata_suggestions SET source_url='https://example.org/changed' WHERE id=?",
                (candidate["id"],),
            )
    elif mutation == "image":
        (service.database.path.parent / "artwork" / draft["payload"]["image_sha256"]).write_bytes(
            b"changed"
        )
    else:
        MetadataEditor(service.repository).save(
            track["id"], MetadataUpdate(version=1, overrides=Overrides(title="User edit"))
        )
    assert tool(api, token, "apply_draft", apply_args(draft)).status_code == 409
    assert not result(api, token, "get_track", {"track_id": track["id"]})["has_cover"]
    with service.database.connect() as db:
        assert db.execute("SELECT count(*) FROM artwork_choices").fetchone()[0] == 0


def test_curation_rejects_forged_snapshot_duplicate_ids_and_missing_scope(curation, monkeypatch):
    api, token, service = curation
    _, track, candidate, draft = cover_draft(api, token, monkeypatch)
    assert (
        tool(
            api,
            token,
            "create_draft",
            {"kind": "cover", "title": "Forged", "payload": draft["payload"]},
        ).status_code
        == 422
    )
    no_manage = create_token(api, ["library:read", "drafts:write"])
    assert (
        tool(api, no_manage, "get_cover_candidates", {"track_id": track["id"]}).status_code == 403
    )
    assert (
        tool(
            api,
            no_manage,
            "create_draft",
            {
                "kind": "cover",
                "title": "Denied",
                "payload": {"suggestion_id": candidate["id"], "metadata_version": 1},
            },
        ).status_code
        == 403
    )
    item = {"track_id": track["id"], "metadata_version": 1, "overrides": {"album": "X"}}
    assert (
        tool(
            api,
            token,
            "create_draft",
            {"kind": "metadata_batch", "title": "Duplicate", "payload": {"items": [item, item]}},
        ).status_code
        == 422
    )
    assert (
        tool(
            api,
            no_manage,
            "create_draft",
            {"kind": "metadata_batch", "title": "Denied", "payload": {"items": [item]}},
        ).status_code
        == 403
    )
    assert tool(api, token, "get_album_tracks", {"album_id": "missing"}).status_code == 404


def test_inspection_rules_use_whole_library_context_and_keep_lyrics_absence_informational(
    settings, authenticated_client, monkeypatch
):
    monkeypatch.setattr(Providers, "start", lambda self: None)
    monkeypatch.setattr(AgentPlatform, "start", lambda self: None)
    for disc in (1, 2):
        path = music(settings, f"disc-{disc}/live.flac", ["Band"], [], album="Live set", number=1)
        tags = FLAC(path)
        tags["discnumber"], tags["disctotal"] = str(disc), "2"
        tags.save()
    music(settings, "same-a.flac", ["Band"], ["Band"], album="Studio", number=1)
    music(settings, "same-b.flac", ["Band"], ["Band"], album="Studio", number=1)
    scan_library(settings)
    with authenticated_client(settings) as api:
        service = api.app.state.agent_platform
        all_tracks = api.get("/api/v1/tracks").json()["items"]
        studio = [t for t in all_tracks if t["album"] == "Studio"]
        for t in studio:
            MetadataEditor(service.repository).save(
                t["id"], MetadataUpdate(version=1, overrides=Overrides(title="Same title"))
            )
        with service.database.connect(write=True) as db:
            db.execute(
                "UPDATE tracks SET duration_ms=duration_ms+5000 WHERE id=?", (studio[0]["id"],)
            )
        token = create_token(api, ["library:read", "tasks:write"])
        rules = result(api, token, "get_inspection_rules")
        assert all(not r["auto_apply"] for r in rules["items"])
        inspected = result(api, token, "inspect_library", {"limit": 1})
        assert inspected["total"] == 4 and inspected["has_more"]
        assert result(api, token, "inspect_library", {"offset": 4})["items"] == []
        # Explicit selection still sees related discs outside its page.
        live_id = next(t["id"] for t in all_tracks if t["album"] == "Live set")
        split = result(
            api,
            token,
            "inspect_library",
            {"track_ids": [live_id], "rules": ["possible_multidisc_split"]},
        )
        assert split["items"][0]["issues"] == ["possible_multidisc_split"]
        pair = result(api, token, "inspect_library", {"track_ids": [studio[0]["id"]]})["items"][0]
        assert {"track_number_conflict", "same_title_versions", "missing_lyrics"} <= set(
            pair["issues"]
        )
        assert (
            next(f for f in pair["findings"] if f["code"] == "missing_lyrics")["severity"] == "info"
        )
        assert tool(api, token, "inspect_library", {"rules": ["invented_rule"]}).status_code == 422
        assert result(api, token, "inspect_library", {"rules": []})["items"][0]["issues"] == []
        task = result(
            api, token, "submit_inspection", {"rules": ["track_number_conflict"], "use_ai": False}
        )
        service.execute_task(service.claim_task())
        completed = result(api, token, "get_task", {"task_id": task["id"]})
        assert completed["status"] == "succeeded" and completed["counts"]["calls"] == 0
        assert completed["counts"]["issues"] == 2
        assert all(set(r["issues"]) <= {"track_number_conflict"} for r in completed["results"])


def test_evidence_links_keep_only_known_music_identifiers():
    assert (
        evidence_url("https://music.163.com/song?id=123&token=private")
        == "https://music.163.com/song?id=123"
    )
    assert (
        evidence_url("https://www.kugou.com/song/#hash=" + "A" * 32 + "&key=private")
        == "https://www.kugou.com/song/#hash=" + "A" * 32
    )
    assert (
        evidence_url("https://musicbrainz.org/release/example?token=private#secret")
        == "https://musicbrainz.org/release/example"
    )
    assert evidence_url("https://private:secret@music.163.com/song?id=123") is None


def test_cover_edit_invalidates_approval_and_cannot_substitute_another_snapshot(
    curation, monkeypatch
):
    api, token, _ = curation
    providers, _, _, draft = cover_draft(api, token, monkeypatch)
    approve(api, draft)
    monkeypatch.setattr(
        providers, "request", lambda *a, **kw: pytest.fail("Editing a title must reuse its image")
    )
    edited = api.patch(
        BASE + f"/drafts/{draft['id']}",
        headers=HEADERS,
        json={"version": 1, "title": "Edited cover title"},
    ).json()
    assert (
        edited["version"] == 2
        and edited["status"] == "pending"
        and edited["approved_version"] is None
    )
    forged = edited["payload"] | {"image_sha256": "0" * 64}
    response = api.patch(
        BASE + f"/drafts/{draft['id']}", headers=HEADERS, json={"version": 2, "payload": forged}
    )
    assert response.status_code == 422
    assert tool(api, token, "apply_draft", apply_args(edited)).status_code == 409


def test_cover_download_rechecks_metadata_after_network_io(curation, monkeypatch):
    api, token, service = curation
    providers, track, candidate, _ = suggestion(api)

    def changed_while_downloading(*args, **kwargs):
        MetadataEditor(service.repository).save(
            track["id"],
            MetadataUpdate(version=1, overrides=Overrides(title="Concurrent user edit")),
        )
        return image("red")

    monkeypatch.setattr(providers, "request", changed_while_downloading)
    response = tool(
        api,
        token,
        "create_draft",
        {
            "kind": "cover",
            "title": "Stale image",
            "payload": {"suggestion_id": candidate["id"], "metadata_version": 1},
        },
    )
    assert response.status_code == 409 and response.json()["detail"] == "metadata_version_conflict"
    assert result(api, token, "list_drafts")["total"] == 0


def test_batch_cannot_edit_another_library(curation, tmp_path):
    from wildstring.library.repository import LibraryRepository

    api, token, service = curation
    tracks = result(api, token, "search_tracks")["items"]
    other = tmp_path / "other-library"
    other.mkdir()
    other_id = LibraryRepository(service.database, other).library_id(create=True)
    with service.database.connect(write=True) as db:
        db.execute("UPDATE tracks SET library_id=? WHERE id=?", (other_id, tracks[1]["id"]))
    response = tool(
        api,
        token,
        "create_draft",
        {
            "kind": "metadata_batch",
            "title": "Cross library",
            "payload": {
                "items": [
                    {
                        "track_id": t["id"],
                        "metadata_version": 1,
                        "overrides": {"album": "Wrong library"},
                    }
                    for t in tracks
                ]
            },
        },
    )
    assert response.status_code == 404
    assert result(api, token, "list_drafts")["total"] == 0
    assert MetadataEditor(service.repository).read(tracks[0]["id"])["version"] == 1


def test_inspection_reports_its_grouping_bound_instead_of_claiming_complete(curation, monkeypatch):
    api, token, _ = curation
    monkeypatch.setattr("wildstring.library.inspection.GROUPING_LIMIT", 1)
    checked = result(api, token, "inspect_library")
    assert checked["total"] == 2 and not checked["grouping_complete"]
    assert all("inspection_context_limited" in item["issues"] for item in checked["items"])
