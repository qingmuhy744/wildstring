"""Real album review selection, immutable evidence and all-or-nothing acceptance."""

import json

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from test_assets import image
from test_personal_library import HEADERS
from test_providers import RECORDING, enable

from wildstring.library.edits import MetadataEditor, MetadataUpdate, Overrides

pytest_plugins = ("test_mcp_curation",)

BASE = "/api/v1/agent/metadata-review"


def seed(api, service):
    providers = service.providers
    providers.stop()
    providers.exit.clear()
    assert enable(api, auto_new=False).status_code == 200
    tracks = api.get("/api/v1/tracks").json()["items"]
    providers.suggestions = lambda _, **kw: (
        [
            (
                "musicbrainz",
                f"https://musicbrainz.org/recording/{RECORDING}",
                {"genres": ["Rock"], "composers": ["New composer"]},
                f"https://coverartarchive.org/release/{RECORDING}/12345.jpg",
                {"score": 99},
            )
        ],
        [],
    )
    providers.enqueue([t["id"] for t in tracks])
    for _ in tracks:
        providers.step()
    return api.get(BASE, params={"track_id": tracks[0]["id"]}).json()


def body(page, key="review-selected-001", fields=None):
    return {
        "idempotency_key": key,
        "items": [
            {
                "track_id": t["id"],
                "metadata_version": t["metadata_version"],
                "suggestion_id": t["suggestions"][0]["id"],
                "candidate_digest": t["suggestions"][0]["candidate_digest"],
                "fields": fields or ["genres"],
            }
            for t in page["items"]
        ],
    }


def test_review_projects_originals_and_applies_selected_fields_once(curation):
    api, token, service = curation
    page = seed(api, service)
    assert len(page["items"]) == 2
    albums = api.get(BASE + "/albums", params={"limit": 1}).json()
    assert albums["total"] == 1 and albums["items"][0]["count"] == 2
    track = page["items"][0]
    assert track["current"] == track["original"] and track["overrides"] == {}
    chosen = body(page)
    chosen["items"] = chosen["items"][:1]
    endpoint = BASE + "/accept"
    response = api.post(endpoint, headers=HEADERS, json=chosen)
    assert response.status_code == 200, response.text
    draft = response.json()["draft"]
    assert response.json()["status"] == "applied"
    assert draft["before"]["items"][0]["source"]["provider"] == "musicbrainz"
    assert api.post(endpoint, headers=HEADERS, json=chosen).json() == response.json()
    editor = MetadataEditor(service.repository)
    assert editor.read(track["id"])["effective"]["genres"] == ["Rock"]
    assert editor.read(track["id"])["overrides"] == {"genres": ["Rock"]}
    assert editor.read(page["items"][1]["id"])["version"] == 1
    chosen["items"][0]["fields"] = ["composers"]
    assert api.post(endpoint, headers=HEADERS, json=chosen).status_code == 409


@pytest.mark.parametrize("change", ["version", "candidate", "status"])
def test_stale_review_reports_conflict_without_partial_write(curation, change):
    api, token, service = curation
    page = seed(api, service)
    chosen = body(page)
    target = page["items"][-1]
    with service.database.connect(write=True) as db:
        if change == "version":
            db.execute(
                "UPDATE track_metadata SET version=version+1 WHERE track_id=?", (target["id"],)
            )
        elif change == "candidate":
            db.execute(
                "UPDATE metadata_suggestions SET fields=? WHERE id=?",
                (json.dumps({"genres": ["Changed"]}), target["suggestions"][0]["id"]),
            )
        else:
            db.execute(
                "UPDATE metadata_suggestions SET status='ignored' WHERE id=?",
                (target["suggestions"][0]["id"],),
            )
        db.commit()
    response = api.post(BASE + "/accept", headers=HEADERS, json=chosen)
    assert response.status_code == 200 and response.json()["status"] == "conflict"
    assert response.json()["conflicts"][0]["track_id"] == target["id"]
    assert MetadataEditor(service.repository).read(page["items"][0]["id"])["overrides"] == {}
    with service.database.connect() as db:
        assert db.execute("SELECT count(*) FROM agent_audit").fetchone()[0] == 0


def test_cover_and_metadata_apply_atomically_using_frozen_image(curation, monkeypatch):
    api, token, service = curation
    page = seed(api, service)
    selected = page["items"][0]
    monkeypatch.setattr(service.providers, "request", lambda *a, **kw: image("red"))
    cover = api.post(
        BASE + "/cover",
        headers=HEADERS,
        json={
            "kind": "cover",
            "title": "Reviewed cover",
            "payload": {
                "suggestion_id": selected["suggestions"][0]["id"],
                "metadata_version": 1,
                "targets": [{"track_id": t["id"], "metadata_version": 1} for t in page["items"]],
            },
        },
    )
    assert cover.status_code == 200, cover.text
    cover = cover.json()
    assert cover["status"] == "pending"
    monkeypatch.setattr(
        service.providers, "request", lambda *a, **kw: pytest.fail("Frozen image must be reused")
    )
    chosen = body(page)
    chosen["cover_draft_id"] = cover["id"]
    original = MetadataEditor.save_in_transaction
    visits = []

    def fail_second(self, db, identity, body, **kwargs):
        original(self, db, identity, body, **kwargs)
        visits.append(identity)
        if len(visits) == 2:
            raise HTTPException(409, "synthetic_batch_failure")

    with monkeypatch.context() as patch:
        patch.setattr(MetadataEditor, "save_in_transaction", fail_second)
        response = api.post(BASE + "/accept", headers=HEADERS, json=chosen)
        assert response.json()["status"] == "conflict", response.text
    with service.database.connect() as db:
        assert db.execute("SELECT count(*) FROM artwork_choices").fetchone()[0] == 0
        assert all(r[0] == 1 for r in db.execute("SELECT version FROM track_metadata"))
        assert all(r[0] == "pending" for r in db.execute("SELECT status FROM metadata_suggestions"))
    response = api.post(BASE + "/accept", headers=HEADERS, json=chosen)
    assert response.status_code == 200 and response.json()["status"] == "applied", response.text
    with service.database.connect() as db:
        assert (
            db.execute(
                "SELECT count(*) FROM artwork_choices WHERE filename=?",
                (cover["payload"]["image_sha256"],),
            ).fetchone()[0]
            == 2
        )
        assert all(r[0] == 2 for r in db.execute("SELECT version FROM track_metadata"))
    assert api.get("/api/v1/agent/drafts/" + cover["id"]).json()["status"] == "applied"


def test_review_is_session_only_and_preserves_unselected_manual_values(curation):
    api, token, service = curation
    page = seed(api, service)
    target = page["items"][0]
    MetadataEditor(service.repository).save(
        target["id"], MetadataUpdate(version=1, overrides=Overrides(composers=["User composer"]))
    )
    page = api.get(BASE, params={"track_id": target["id"]}).json()
    assert page["items"][0]["overrides"] == {"composers": ["User composer"]}
    assert (
        api.post(
            BASE + "/accept", headers={"Authorization": token["Authorization"]}, json=body(page)
        ).status_code
        == 403
    )
    with TestClient(api.app) as external:
        assert external.get(BASE, headers=token).status_code == 401
    chosen = body(page)
    chosen["items"] = chosen["items"][1:]
    assert api.post(BASE + "/accept", headers=HEADERS, json=chosen).json()["status"] == "applied"
    assert MetadataEditor(service.repository).read(target["id"])["overrides"] == {
        "composers": ["User composer"]
    }
