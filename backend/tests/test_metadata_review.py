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


def test_review_marks_old_candidate_version_stale_and_requires_new_query(curation):
    api, token, service = curation
    page = seed(api, service)
    target = page["items"][0]
    with service.database.connect(write=True) as db:
        db.execute("UPDATE track_metadata SET version=version+1 WHERE track_id=?", (target["id"],))
    refreshed = api.get(BASE, params={"track_id": target["id"]}).json()
    candidate = refreshed["items"][0]["suggestions"][0]
    assert candidate["stale"] is True
    assert candidate["stale_reason"] == "歌曲信息版本已变化，请重新查询"
    request = body(refreshed)
    response = api.post(BASE + "/accept", headers=HEADERS, json=request)
    assert response.status_code == 200
    assert response.json()["status"] == "conflict"
    assert response.json()["conflicts"][0]["error_code"] == "metadata_version_conflict"


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


def duplicate(service, identity, **changes):
    from uuid import uuid4

    with service.database.connect(write=True) as db:
        row = dict(
            db.execute("SELECT * FROM metadata_suggestions WHERE id=?", (identity,)).fetchone()
        )
        row.update(id=uuid4().hex, **changes)
        db.execute(
            "INSERT INTO metadata_suggestions(id,job_id,track_id,metadata_version,provider,source_url,fields,cover_url,status,created_at,match) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            tuple(
                row[key]
                for key in (
                    "id",
                    "job_id",
                    "track_id",
                    "metadata_version",
                    "provider",
                    "source_url",
                    "fields",
                    "cover_url",
                    "status",
                    "created_at",
                    "match",
                )
            ),
        )
    return row


def reject_body(track):
    return {
        key: value for key, value in body({"items": [track]})["items"][0].items() if key != "fields"
    }


def test_review_collapses_content_before_limit_but_preserves_releases_and_sources(curation):
    api, token, service = curation
    page = seed(api, service)
    track = page["items"][0]
    identity = track["suggestions"][0]["id"]
    for i in range(40):
        last = duplicate(
            service,
            identity,
            fields=json.dumps({"composers": ["New composer"], "genres": ["Rock"]}),
            created_at=2000000000 + i,
            match=json.dumps({"score": i / 100}),
        )
    duplicate(
        service,
        identity,
        fields=json.dumps({"genres": ["Rock"], "album": "Live version"}),
        created_at=2000000100,
    )
    duplicate(service, identity, provider="lastfm", created_at=2000000101)
    result = api.get(BASE, params={"track_id": track["id"]}).json()["items"][0]["suggestions"]
    assert len(result) == 3
    source = next(r for r in result if r["id"] == last["id"])
    assert source["duplicate_count"] == 41 and source["match"]["score"] == 0.39
    assert any(r["fields"].get("album") == "Live version" for r in result)
    assert any(r["provider"] == "lastfm" for r in result)


def test_rejection_ignores_observed_duplicates_not_new_lookup_or_other_release(curation):
    api, token, service = curation
    track = seed(api, service)["items"][0]
    original = track["suggestions"][0]["id"]
    older = duplicate(service, original, created_at=2000000000)
    track = api.get(BASE, params={"track_id": track["id"]}).json()["items"][0]
    newer = duplicate(service, original, created_at=2000000010)
    release = duplicate(service, original, fields=json.dumps({"album": "Other release"}))
    before = MetadataEditor(service.repository).read(track["id"])
    response = api.post(BASE + "/reject", headers=HEADERS, json=reject_body(track))
    assert response.status_code == 200, response.text
    assert response.json() == {"status": "ignored", "ignored_count": 2, "already_ignored": False}
    assert api.post(BASE + "/reject", headers=HEADERS, json=reject_body(track)).json()[
        "already_ignored"
    ]
    with service.database.connect() as db:
        values = dict(
            db.execute(
                "SELECT id,status FROM metadata_suggestions WHERE track_id=?", (track["id"],)
            )
        )
    assert values[original] == values[older["id"]] == "ignored"
    assert values[newer["id"]] == values[release["id"]] == "pending"
    assert MetadataEditor(service.repository).read(track["id"]) == before
    refreshed = api.get(BASE, params={"track_id": track["id"]}).json()["items"][0]["suggestions"]
    assert {r["id"] for r in refreshed} == {newer["id"], release["id"]}


@pytest.mark.parametrize("change", ["version", "candidate", "applied", "track"])
def test_rejection_conflict_does_not_discard_other_candidates(curation, change):
    api, token, service = curation
    page = seed(api, service)
    track = page["items"][0]
    request = reject_body(track)
    with service.database.connect(write=True) as db:
        if change == "version":
            db.execute(
                "UPDATE track_metadata SET version=version+1 WHERE track_id=?", (track["id"],)
            )
        elif change == "candidate":
            db.execute(
                "UPDATE metadata_suggestions SET fields='{}' WHERE id=?",
                (request["suggestion_id"],),
            )
        elif change == "applied":
            db.execute(
                "UPDATE metadata_suggestions SET status='applied' WHERE id=?",
                (request["suggestion_id"],),
            )
        else:
            request["track_id"] = page["items"][1]["id"]
    response = api.post(BASE + "/reject", headers=HEADERS, json=request)
    assert response.status_code == (404 if change == "track" else 409)
    with service.database.connect() as db:
        assert (
            db.execute(
                "SELECT count(*) FROM metadata_suggestions WHERE status='ignored'"
            ).fetchone()[0]
            == 0
        )


def test_rejection_permission_and_stale_candidates_do_not_inflate_pending_albums(curation):
    api, token, service = curation
    page = seed(api, service)
    request = reject_body(page["items"][0])
    assert api.post(BASE + "/reject", json=request).status_code == 403
    with TestClient(api.app) as external:
        assert external.post(BASE + "/reject", headers=token, json=request).status_code == 401
    target = page["items"][0]
    MetadataEditor(service.repository).save(
        target["id"], MetadataUpdate(version=1, overrides=Overrides(title="Changed title"))
    )
    albums = api.get(BASE + "/albums").json()
    assert albums["items"][0]["count"] == 1
    current = api.get(BASE, params={"track_id": target["id"]}).json()["items"][0]
    assert api.post(BASE + "/reject", headers=HEADERS, json=reject_body(current)).status_code == 200


def test_rejection_does_not_hide_later_lookup_when_wall_clock_moves_back(curation):
    api, token, service = curation
    track = seed(api, service)["items"][0]
    original = track["suggestions"][0]["id"]
    later = duplicate(service, original, created_at=1)
    assert (
        api.post(BASE + "/reject", headers=HEADERS, json=reject_body(track)).json()["ignored_count"]
        == 1
    )
    refreshed = api.get(BASE, params={"track_id": track["id"]}).json()["items"][0]["suggestions"]
    assert len(refreshed) == 1 and refreshed[0]["id"] == later["id"]


def test_rejection_by_album_id_ignores_all_pending_suggestions_for_album(curation):
    api, token, service = curation
    seed(api, service)
    album = api.get(BASE + "/albums").json()["items"][0]
    assert album["count"] == 2
    response = api.post(BASE + "/reject", headers=HEADERS, json={"album_id": album["id"]})
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["status"] == "ignored"
    assert data["ignored_count"] == 2
    assert not data["already_ignored"]

    # Pending album list is now empty
    refreshed_albums = api.get(BASE + "/albums").json()
    assert refreshed_albums["total"] == 0
    assert len(refreshed_albums["items"]) == 0

    # Repeat reject reports already_ignored
    repeat = api.post(BASE + "/reject", headers=HEADERS, json={"album_id": album["id"]})
    assert repeat.json()["already_ignored"] is True


def test_purge_stale_metadata_suggestions(curation):
    api, token, service = curation
    seed(api, service)
    album = api.get(BASE + "/albums").json()["items"][0]
    track_id = api.get(BASE, params={"album_id": album["id"]}).json()["items"][0]["id"]

    # Invalidate track metadata version in DB to make suggestion stale
    with service.database.connect(write=True) as db:
        db.execute(
            "UPDATE track_metadata SET version = version + 1 WHERE track_id = ?", (track_id,)
        )

    response = api.post(BASE + "/stale/purge", headers=HEADERS)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["status"] == "purged"
    assert data["purged_count"] >= 1

    # Repeat purge reports 0 purged
    repeat = api.post(BASE + "/stale/purge", headers=HEADERS)
    assert repeat.json()["purged_count"] == 0
