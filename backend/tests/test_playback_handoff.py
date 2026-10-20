"""Only recent, explicit pause events may trigger an automatic handoff offer."""

from test_mobile_experience import BASE, seed, snapshot, tracks
from test_personal_library import HEADERS

from wildstring.database import Database


def test_pause_event_is_stable_expires_and_resets_only_after_playback(
    settings, authenticated_client, monkeypatch
):
    clock = ["2026-10-19T10:00:00+00:00"]
    monkeypatch.setattr("wildstring.playback_state.now", lambda: clock[0])
    seed(settings, 2)
    with authenticated_client(settings) as client:
        items = tracks(client)
        body = snapshot(items, playback_state="playing")

        def save(**changes):
            nonlocal body
            body |= changes
            response = client.put(BASE + "/playback/state", json=body, headers=HEADERS)
            assert response.status_code == 200
            result = response.json()
            body["version"] = result["version"]
            return result

        playing = save()
        assert playing["handoff_supported"]
        assert not playing["handoff_eligible"] and playing["paused_at"] is None
        clock[0] = "2026-10-19T10:00:30+00:00"
        paused = save(playback_state="paused", position_ms=100)
        assert paused["handoff_eligible"] and paused["paused_at"] == clock[0]
        clock[0] = "2026-10-19T10:20:30+00:00"
        moved = save(position_ms=200)
        assert moved["handoff_eligible"] and moved["paused_at"] == paused["paused_at"]
        assert moved["updated_at"] != moved["paused_at"]
        clock[0] = "2026-10-19T10:31:00+00:00"
        expired = client.get(BASE + "/playback/state").json()
        assert not expired["handoff_eligible"]
        assert expired["track_ids"] == paused["track_ids"]  # Manual loading remains available.
        assert save(playback_state="playing")["paused_at"] is None
        clock[0] = "2026-10-19T10:32:00+00:00"
        again = save(playback_state="paused")
        assert again["handoff_eligible"] and again["paused_at"] != paused["paused_at"]
        assert not save(playback_state="ended")["handoff_eligible"]


def test_legacy_unknown_future_and_empty_snapshots_never_prompt(
    settings, authenticated_client, monkeypatch
):
    monkeypatch.setattr("wildstring.playback_state.now", lambda: "2026-10-19T10:00:00+00:00")
    seed(settings, 1)
    with authenticated_client(settings) as client:
        items = tracks(client)
        legacy = client.put(BASE + "/playback/state", json=snapshot(items), headers=HEADERS).json()
        assert legacy["playback_state"] == "unknown"
        assert not legacy["handoff_eligible"] and legacy["paused_at"] is None
        paused = snapshot(items, version=legacy["version"], playback_state="paused")
        result = client.put(BASE + "/playback/state", json=paused, headers=HEADERS).json()
        assert result["handoff_eligible"]
        for timestamp in ("2099-01-01T00:00:00+00:00", "invalid", "2026-10-19T10:00:00"):
            with Database(settings.data_dir).connect(write=True) as connection:
                connection.execute("UPDATE playback_states SET paused_at=?", (timestamp,))
            assert not client.get(BASE + "/playback/state").json()["handoff_eligible"]
        empty = client.put(
            BASE + "/playback/state",
            json=snapshot([], version=result["version"], playback_state="paused"),
            headers=HEADERS,
        ).json()
        assert not empty["handoff_eligible"]


def test_pause_time_is_server_owned_and_unavailable_tracks_cannot_offer(
    settings, authenticated_client
):
    seed(settings, 1)
    with authenticated_client(settings) as client:
        items = tracks(client)
        body = snapshot(items, playback_state="paused")
        for extra in ({"paused_at": "2099-01-01T00:00:00Z"}, {"handoff_eligible": True}):
            response = client.put(BASE + "/playback/state", json=body | extra, headers=HEADERS)
            assert response.status_code == 422
        saved = client.put(BASE + "/playback/state", json=body, headers=HEADERS).json()
        assert saved["handoff_eligible"]
        with Database(settings.data_dir).connect(write=True) as connection:
            connection.execute("UPDATE tracks SET status='missing'")
        missing = client.get(BASE + "/playback/state").json()
        assert missing["track_ids"] == [] and not missing["handoff_eligible"]


def test_schema22_snapshot_migrates_without_becoming_a_pause_offer(settings, authenticated_client):
    seed(settings, 2)
    with authenticated_client(settings) as client:
        items = tracks(client)
        original = client.put(
            BASE + "/playback/state",
            json=snapshot(items, index=1, position_ms=100),
            headers=HEADERS,
        ).json()
    database = Database(settings.data_dir)
    with database.connect(write=True) as connection:
        from migration_support import pre23

        pre23(connection)
        connection.execute("PRAGMA user_version=22")
    database.initialize()
    database.initialize()
    assert database.check_ready()
    with authenticated_client(settings) as client:
        restored = client.get(BASE + "/playback/state").json()
        for field in (
            "version",
            "device_id",
            "track_ids",
            "index",
            "position_ms",
            "mode",
            "updated_at",
        ):
            assert restored[field] == original[field]
        assert restored["playback_state"] == "unknown" and restored["paused_at"] is None
        assert not restored["handoff_eligible"]
        assert len(tracks(client)) == len(items)
