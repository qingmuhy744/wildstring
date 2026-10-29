"""Shared publisher assignments with account-scoped listening state."""

import pytest
from fastapi.testclient import TestClient

from wildstring.database import SCHEMA_VERSION, Database

HEADERS = {"X-Wildstring-Client": "web"}
ROOT = "/api/v1/podcasts"


def seed(database):
    with database.connect(write=True) as connection:
        for identifier, author in (
            ("east", "ETW Studio"),
            ("coffee", "声动活泼"),
            ("other", "ETW Studio"),
        ):
            connection.execute(
                "INSERT INTO podcasts(id,title,author,feed_url,auto_update,download_policy,created_at) "
                "VALUES (?,?,?,?,0,'none','2026-10-25')",
                (identifier, identifier, author, f"https://example.com/{identifier}.rss"),
            )
            connection.execute(
                "INSERT INTO podcast_episodes(id,podcast_id,guid,title,audio_url,created_at) "
                "VALUES (?,?,?,?,?,'2026-10-25')",
                (
                    f"ep-{identifier}",
                    identifier,
                    identifier,
                    identifier,
                    "https://example.com/audio.mp3",
                ),
            )


@pytest.fixture
def publisher_client(settings, authenticated_client):
    with authenticated_client(settings) as client:
        database = Database(settings.data_dir)
        seed(database)
        yield client, database


def assign(client, identifier, **body):
    return client.put(f"{ROOT}/{identifier}/publisher", json=body, headers=HEADERS)


def account(client, profile="listener"):
    response = client.post(
        "/api/v1/manage/users",
        headers=HEADERS,
        json={
            "username": "publisher-user",
            "password": "publisher-test-password",
            "profile": profile,
        },
    )
    assert response.status_code == 201
    with client.app.state.podcasts.database.connect(write=True) as db:
        db.execute("INSERT INTO podcast_user_catalog VALUES (?,?)", (response.json()["id"], "east"))
    other = TestClient(client.app)
    assert (
        other.post(
            "/api/v1/auth/login",
            headers=HEADERS,
            json={"username": "publisher-user", "password": "publisher-test-password"},
        ).status_code
        == 200
    )
    return other


def test_only_explicitly_confirmed_programmes_are_aggregated(publisher_client):
    client, database = publisher_client
    assert client.get(f"{ROOT}/publishers").json() == []
    assert all(show["publisher"] is None for show in client.get(ROOT).json())
    first = assign(client, "east", version=1, name="  声动活泼  ")
    assert first.status_code == 200
    podcast = first.json()["podcast"]
    publisher = podcast["publisher"]
    assert publisher["name"] == "声动活泼"
    assert podcast["author"] == "ETW Studio"
    assert podcast["publisher_version"] == 2
    assert assign(client, "coffee", version=1, publisher_id=publisher["id"]).status_code == 200
    overview = client.get(f"{ROOT}/publishers").json()
    assert overview == [{**publisher, "podcast_count": 2}]
    group = client.get(f"{ROOT}/publishers/{publisher['id']}").json()
    assert {show["id"] for show in group["podcasts"]} == {"east", "coffee"}
    # Feed author changes cannot replace the separately confirmed affiliation.
    with database.connect(write=True) as connection:
        connection.execute("UPDATE podcasts SET author='updated feed author' WHERE id='east'")
    assert client.get(f"{ROOT}/east").json()["podcast"]["publisher"] == publisher
    assert client.get(f"{ROOT}/other").json()["podcast"]["publisher"] is None


def test_correct_clear_and_reuse_confirmed_name(publisher_client):
    client, _ = publisher_client
    first = assign(client, "east", version=1, name="Studio A").json()["podcast"]["publisher"]
    reused = assign(client, "coffee", version=1, name="ｓｔｕｄｉｏ a").json()["podcast"][
        "publisher"
    ]
    assert reused == first
    correction = assign(client, "east", version=2, name="Studio B").json()["podcast"]
    assert correction["publisher"]["id"] != first["id"]
    assert client.get(f"{ROOT}/publishers/{first['id']}").json()["publisher"]["podcast_count"] == 1
    cleared = assign(client, "east", version=3, publisher_id=None).json()["podcast"]
    assert cleared["publisher"] is None
    assert cleared["publisher_version"] == 4
    assert cleared["author"] == "ETW Studio"
    assert cleared["total_episodes"] == 1


def test_conflicts_and_invalid_targets_do_not_mutate_shared_data(publisher_client):
    client, database = publisher_client
    first = assign(client, "east", version=1, name="Confirmed").json()["podcast"]
    assert assign(client, "east", version=1, name="Must not be created").status_code == 409
    assert assign(client, "east", version=2, publisher_id="missing").status_code == 404
    assert assign(client, "missing", version=1, name="Must not be created").status_code == 404
    assert client.get(f"{ROOT}/publishers/missing").status_code == 404
    assert client.get(f"{ROOT}/east").json()["podcast"]["publisher"] == first["publisher"]
    with database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM podcast_publishers").fetchone()[0] == 1
    for body in (
        {"version": 2, "name": "   "},
        {"version": 2, "name": "x" * 121},
        {"version": 2, "name": "x\x00y"},
        {"version": 2, "name": "A", "publisher_id": "B"},
        {"version": True, "name": "A"},
        {"version": 2, "name": "A", "user_id": "admin"},
    ):
        assert assign(client, "east", **body).status_code == 422


@pytest.mark.parametrize(
    "profile,expected", [("listener", 403), ("editor", 200), ("librarian", 200)]
)
def test_publisher_writes_reuse_metadata_permissions(publisher_client, profile, expected):
    client, _ = publisher_client
    other = account(client, profile)
    try:
        assert other.get(f"{ROOT}/publishers").status_code == 200
        assert assign(other, "east", version=1, name="Confirmed").status_code == expected
    finally:
        other.close()


def test_publisher_membership_shared_but_unplayed_counts_are_personal(publisher_client):
    client, database = publisher_client
    publisher = assign(client, "east", version=1, name="Shared").json()["podcast"]["publisher"]
    with database.connect(write=True) as connection:
        connection.execute(
            "INSERT INTO podcast_progress(user_id,episode_id,completed,last_listened_at) "
            "VALUES ('admin','ep-east',1,'2026-10-25')"
        )
    url = f"{ROOT}/publishers/{publisher['id']}"
    assert client.get(url).json()["podcasts"][0]["unplayed_episodes"] == 0
    other = account(client)
    try:
        group = other.get(url).json()
        assert group["publisher"] == {**publisher, "podcast_count": 1}
        assert group["podcasts"][0]["unplayed_episodes"] == 1
    finally:
        other.close()
    anonymous = TestClient(client.app)
    try:
        assert anonymous.get(url).status_code == 401
        assert anonymous.get(f"{ROOT}/publishers").status_code == 401
    finally:
        anonymous.close()
    assert client.put(f"{ROOT}/east/publisher", json={"version": 2}).status_code == 403


def test_schema34_upgrade_preserves_programmes_and_is_repeatable(settings):
    database = Database(settings.data_dir)
    database.initialize()
    seed(database)
    with database.connect(write=True) as connection:
        connection.execute("DROP INDEX podcasts_by_publisher")
        connection.execute("ALTER TABLE podcasts DROP COLUMN publisher_id")
        connection.execute("ALTER TABLE podcasts DROP COLUMN publisher_version")
        connection.execute("DROP TABLE podcast_publishers")
        connection.execute("PRAGMA user_version=34")
    database.initialize()
    database.initialize()
    with database.connect() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        assert connection.execute("SELECT COUNT(*) FROM podcast_episodes").fetchone()[0] == 3
        rows = connection.execute("SELECT publisher_id,publisher_version FROM podcasts").fetchall()
        assert all(tuple(row) == (None, 1) for row in rows)
