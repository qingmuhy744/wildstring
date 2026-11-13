"""Ordered podcast queue and per-show new-episode delivery.

See contracts/podcast-queue.md. This is an independent channel: the music
playback snapshot (playback_states) and its track validation are untouched.
``podcast_inbox_baseline`` only records which episodes already existed when a
user followed a show. It is not a listen-later list.
"""

import json
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

from wildstring.podcast_access import require_programme

ACTION_PATTERN = "^(queue_last|queue_next|ignore)$"
ORDER_PATTERN = "^(follow|asc|desc|off)$"
GLOBAL_SHOW = ""
QUEUE_CAP = 5000
NOTICE_FULL = "queue_full"


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _episode_podcast(connection, user_id: str, episode_id: str) -> str | None:
    """Return the episode's show when the user may access it, else None."""
    row = connection.execute(
        "SELECT podcast_id FROM podcast_episodes WHERE id=?", (episode_id,)
    ).fetchone()
    if row is None:
        return None
    try:
        require_programme(connection, user_id, row["podcast_id"])
    except HTTPException:
        return None
    return row["podcast_id"]


def _published_stamp(raw: str) -> float:
    if not raw:
        return 0.0
    try:
        parsed = parsedate_to_datetime(raw)
    except (TypeError, ValueError, OverflowError):
        parsed = None
    if parsed is not None:
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return parsed.timestamp()
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return 0.0
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.timestamp()


def _ordered_episode_ids(connection, episode_ids: list[str], *, newest_first: bool) -> list[str]:
    if not episode_ids:
        return []
    placeholders = ",".join("?" * len(episode_ids))
    rows = {
        row["id"]: row
        for row in connection.execute(
            f"SELECT id, pub_date, episode_number FROM podcast_episodes WHERE id IN ({placeholders})",  # nosec B608 -- placeholders only
            tuple(episode_ids),
        )
    }
    order = {episode_id: position for position, episode_id in enumerate(episode_ids)}

    def key(episode_id: str) -> tuple[float, int, int]:
        row = rows.get(episode_id)
        number = 0
        if row is not None and row["episode_number"] is not None:
            number = int(row["episode_number"])
        return (_published_stamp(row["pub_date"] if row else ""), number, order[episode_id])

    ordered = sorted(episode_ids, key=key)
    if newest_first:
        ordered.reverse()
    return ordered


def _queue_rows(connection, user_id):
    row = connection.execute(
        """SELECT items_json, version, device_id, updated_at, notice
           FROM podcast_queue_state WHERE user_id=?""",
        (user_id,),
    ).fetchone()
    if row is None:
        return [], 0, "", None, ""
    try:
        items = json.loads(row["items_json"])
    except (TypeError, ValueError):
        items = []
    if not isinstance(items, list):
        items = []
    return items, row["version"], row["device_id"], row["updated_at"], row["notice"] or ""


def _save_queue(connection, user_id, items, device_id, version, notice="") -> None:
    connection.execute(
        """INSERT INTO podcast_queue_state
           (user_id, items_json, version, device_id, updated_at, notice) VALUES (?,?,?,?,?,?)
           ON CONFLICT(user_id) DO UPDATE SET
             items_json=excluded.items_json,
             version=excluded.version,
             device_id=excluded.device_id,
             updated_at=excluded.updated_at,
             notice=excluded.notice""",
        (user_id, json.dumps(items, separators=(",", ":")), version, device_id, _now(), notice),
    )


def _set_notice(connection, user_id, notice: str) -> None:
    items, version, device_id, updated_at, current = _queue_rows(connection, user_id)
    if current == notice and updated_at is not None:
        return
    connection.execute(
        """INSERT INTO podcast_queue_state
           (user_id, items_json, version, device_id, updated_at, notice)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(user_id) DO UPDATE SET notice=excluded.notice""",
        (
            user_id,
            json.dumps(items, separators=(",", ":")),
            version,
            device_id,
            updated_at or _now(),
            notice,
        ),
    )


def _prefs(connection, user_id, podcast_id):
    row = connection.execute(
        """SELECT action, auto_limit, episode_order, skip_completed, auto_continue
           FROM podcast_queue_prefs WHERE user_id=? AND podcast_id=?""",
        (user_id, podcast_id),
    ).fetchone()
    if row is None:
        row = connection.execute(
            """SELECT action, auto_limit, episode_order, skip_completed, auto_continue
               FROM podcast_queue_prefs WHERE user_id=? AND podcast_id=?""",
            (user_id, GLOBAL_SHOW),
        ).fetchone()
    if row is None:
        return {
            "action": "queue_last",
            "auto_limit": 3,
            "order": "follow",
            "skip_completed": True,
            "auto_continue": True,
        }
    return {
        "action": row["action"],
        "auto_limit": row["auto_limit"],
        "order": row["episode_order"],
        "skip_completed": bool(row["skip_completed"]),
        "auto_continue": bool(row["auto_continue"]),
    }


def ensure_baseline(connection, user_id, podcast_id) -> None:
    """Mark every episode existing at follow time as historical for this user."""
    connection.execute(
        """INSERT OR IGNORE INTO podcast_inbox_baseline
           (user_id, podcast_id, completed_at) VALUES (?,?,?)""",
        (user_id, podcast_id, _now()),
    )


def apply_serial_default(connection, user_id, podcast_id) -> None:
    """Serial shows start closed and oldest-to-newest until the user chooses otherwise."""
    row = connection.execute("SELECT show_type FROM podcasts WHERE id=?", (podcast_id,)).fetchone()
    if row is None or row["show_type"] != "serial":
        return
    existing = connection.execute(
        "SELECT 1 FROM podcast_queue_prefs WHERE user_id=? AND podcast_id=?",
        (user_id, podcast_id),
    ).fetchone()
    if existing is not None:
        return
    connection.execute(
        """INSERT INTO podcast_queue_prefs
           (user_id, podcast_id, action, auto_limit, episode_order, skip_completed, auto_continue)
           VALUES (?,?,?,?,?,?,?)""",
        (user_id, podcast_id, "ignore", 3, "asc", 1, 1),
    )


def distribute_new_episodes(connection, podcast_id, episode_ids) -> int:
    """Deliver freshly inserted episodes to followers according to their show settings.

    Called inside the RSS refresh transaction. Episode identity, not publication
    date, decides what counts as new; publication date only orders one batch.
    ``queue_next`` places the batch at the front of the queue, newest first.
    ``queue_last`` appends it, oldest first. Neither call changes what is playing.
    """
    if not episode_ids:
        return 0
    followers = [
        row["user_id"]
        for row in connection.execute(
            "SELECT user_id FROM podcast_follows WHERE podcast_id=?", (podcast_id,)
        )
    ]
    delivered = 0
    for user_id in followers:
        baseline = connection.execute(
            "SELECT 1 FROM podcast_inbox_baseline WHERE user_id=? AND podcast_id=?",
            (user_id, podcast_id),
        ).fetchone()
        if baseline is None:
            continue
        preference = _prefs(connection, user_id, podcast_id)
        action = preference["action"]
        if action == "ignore":
            continue
        newest_first = action == "queue_next"
        ordered = _ordered_episode_ids(connection, list(episode_ids), newest_first=newest_first)
        items, version, device_id, _, _ = _queue_rows(connection, user_id)
        present = {item.get("episode_id") for item in items if isinstance(item, dict)}
        fresh = [episode_id for episode_id in ordered if episode_id not in present]
        if not fresh:
            continue
        if len(items) + len(fresh) > QUEUE_CAP:
            _set_notice(connection, user_id, NOTICE_FULL)
            continue
        stamp = _now()
        entries = [
            {"episode_id": episode_id, "origin": "rule", "added_at": stamp} for episode_id in fresh
        ]
        items = entries + items if newest_first else items + entries
        _save_queue(connection, user_id, items, device_id, version + 1, notice="")
        delivered += 1
    return delivered


class QueueItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    episode_id: str = Field(min_length=1, max_length=128)
    origin: str = Field(default="manual", pattern="^(manual|rule)$")
    # Preserved across rewrites; tolerate explicit null from Gson serializeNulls() clients.
    added_at: str = Field(default="", max_length=64)

    @field_validator("added_at", mode="before")
    @classmethod
    def _coerce_null_added_at(cls, value: Any) -> Any:
        return "" if value is None else value


class QueueUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=0)
    device_id: str = Field(default="", max_length=128)
    items: list[QueueItem] = Field(default_factory=list, max_length=5000)


class ShowPreference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: str = Field(default="queue_last", pattern=ACTION_PATTERN)
    auto_limit: int = Field(default=3, ge=0, le=100)
    order: str = Field(default="follow", pattern=ORDER_PATTERN)
    skip_completed: bool = True
    auto_continue: bool = True


class PreferencesUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    default_action: str = Field(default="queue_last", pattern=ACTION_PATTERN)
    auto_limit: int = Field(default=3, ge=0, le=100)
    # Account-wide playback default. Show rows may override auto_continue.
    auto_continue: bool = True
    shows: dict[str, ShowPreference] = Field(default_factory=dict)


def _write_pref(connection, user_id, podcast_id, preference) -> None:
    connection.execute(
        """INSERT INTO podcast_queue_prefs
           (user_id, podcast_id, action, auto_limit, episode_order, skip_completed, auto_continue)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(user_id, podcast_id) DO UPDATE SET
             action=excluded.action,
             auto_limit=excluded.auto_limit,
             episode_order=excluded.episode_order,
             skip_completed=excluded.skip_completed,
             auto_continue=excluded.auto_continue""",
        (
            user_id,
            podcast_id,
            preference.action,
            preference.auto_limit,
            preference.order,
            int(preference.skip_completed),
            int(preference.auto_continue),
        ),
    )


def _read_prefs(connection, user_id):
    global_row = connection.execute(
        """SELECT action, auto_limit, auto_continue FROM podcast_queue_prefs
           WHERE user_id=? AND podcast_id=?""",
        (user_id, GLOBAL_SHOW),
    ).fetchone()
    shows = {}
    for row in connection.execute(
        """SELECT podcast_id, action, auto_limit, episode_order, skip_completed, auto_continue
           FROM podcast_queue_prefs WHERE user_id=? AND podcast_id<>?""",
        (user_id, GLOBAL_SHOW),
    ):
        shows[row["podcast_id"]] = {
            "action": row["action"],
            "auto_limit": row["auto_limit"],
            "order": row["episode_order"],
            "skip_completed": bool(row["skip_completed"]),
            "auto_continue": bool(row["auto_continue"]),
        }
    return {
        "default_action": global_row["action"] if global_row else "queue_last",
        "auto_limit": global_row["auto_limit"] if global_row else 3,
        "auto_continue": bool(global_row["auto_continue"]) if global_row else True,
        "shows": shows,
    }


def routes(router: APIRouter, auth: Any, database: Any) -> None:
    session = auth.require_session

    @router.get("/queue")
    def get_queue(user: Annotated[dict, Depends(session)]):
        with database.connect() as connection:
            items, version, device_id, updated_at, notice = _queue_rows(connection, user["id"])
        return {
            "version": version,
            "device_id": device_id,
            "items": items,
            "updated_at": updated_at,
            "notice": notice,
        }

    @router.put("/queue", dependencies=[Depends(auth.require_client)])
    def put_queue(body: QueueUpdate, user: Annotated[dict, Depends(session)]):
        with database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            items, version, _, updated_at, _ = _queue_rows(connection, user["id"])
            if body.version != version:
                raise HTTPException(
                    409,
                    {
                        "code": "podcast_queue_conflict",
                        "current": {"version": version, "items": items},
                    },
                )
            previous = {
                entry.get("episode_id"): entry.get("added_at", "")
                for entry in items
                if isinstance(entry, dict)
            }
            # Legacy entries carry no timestamp; keep them ahead of newly joined ones.
            fallback = updated_at or _now()
            clean = []
            for item in body.items:
                if _episode_podcast(connection, user["id"], item.episode_id) is None:
                    raise HTTPException(422, "episode_unavailable")
                clean.append(
                    {
                        "episode_id": item.episode_id,
                        "origin": item.origin,
                        "added_at": item.added_at or previous.get(item.episode_id) or fallback,
                    }
                )
            _save_queue(connection, user["id"], clean, body.device_id, version + 1)
        return {"version": version + 1, "items": clean, "notice": ""}

    @router.get("/queue/preferences")
    def get_preferences(user: Annotated[dict, Depends(session)]):
        with database.connect() as connection:
            return _read_prefs(connection, user["id"])

    @router.put("/queue/preferences", dependencies=[Depends(auth.require_client)])
    def put_preferences(body: PreferencesUpdate, user: Annotated[dict, Depends(session)]):
        with database.connect(write=True) as connection:
            valid_shows: list[tuple[str, ShowPreference]] = []
            for podcast_id, preference in body.shows.items():
                if not podcast_id:
                    continue
                try:
                    require_programme(connection, user["id"], podcast_id)
                except HTTPException as error:
                    raise HTTPException(422, "podcast_unavailable") from error
                valid_shows.append((podcast_id, preference))
            connection.execute(
                "DELETE FROM podcast_queue_prefs WHERE user_id=? AND podcast_id<>?",
                (user["id"], GLOBAL_SHOW),
            )
            _write_pref(
                connection,
                user["id"],
                GLOBAL_SHOW,
                ShowPreference(
                    action=body.default_action,
                    auto_limit=body.auto_limit,
                    auto_continue=body.auto_continue,
                ),
            )
            for podcast_id, preference in valid_shows:
                _write_pref(connection, user["id"], podcast_id, preference)
            return _read_prefs(connection, user["id"])
