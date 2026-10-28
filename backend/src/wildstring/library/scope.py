"""Library identity and actor scope, independent of storage and HTTP routing."""

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException


@dataclass(frozen=True)
class LibraryContext:
    user_id: str
    library_id: str | None = None
    source_id: str = "import"


current_library: ContextVar[LibraryContext | None] = ContextVar("library_context", default=None)


@contextmanager
def library_context(user_id, library_id=None, source_id="import"):
    token = current_library.set(LibraryContext(user_id, library_id, source_id))
    try:
        yield
    finally:
        current_library.reset(token)


def allowed_ids(connection, user_id):
    user = connection.execute("SELECT profile,enabled FROM users WHERE id=?", (user_id,)).fetchone()
    if user is None or not user["enabled"]:
        return set()
    if user["profile"] == "owner":
        return {r[0] for r in connection.execute("SELECT id FROM libraries WHERE enabled=1")}
    return {
        r[0]
        for r in connection.execute(
            "SELECT l.id FROM libraries l JOIN user_library_access a ON a.library_id=l.id "
            "WHERE a.user_id=? AND l.enabled=1",
            (user_id,),
        )
    }


def configure_scope(connection, user_id):
    context = current_library.get()
    user_id = context.user_id if context else user_id
    visible = allowed_ids(connection, user_id)
    connection.create_function("active_user", 0, lambda: user_id)
    default = connection.execute("SELECT id FROM libraries WHERE is_default=1 LIMIT 1").fetchone()
    home = default[0] if default and default[0] in visible else min(visible) if visible else None
    connection.create_function(
        "active_library", 0, lambda: context.library_id if context and context.library_id else home
    )
    connection.create_function("library_visible", 1, lambda identity: int(identity in visible))
    connection.create_function(
        "library_selected",
        2,
        lambda identity, fallback: int(
            identity in visible
            and (
                identity == context.library_id
                if context and context.library_id
                else True
                if context
                else identity == fallback
            )
        ),
    )


def object_library(connection, identity):
    for query in (
        "SELECT library_id FROM agent_tasks WHERE id=?",
        "SELECT library_id FROM agent_drafts WHERE id=?",
        "SELECT library_id FROM admin_jobs WHERE id=?",
        "SELECT library_id FROM intake_items WHERE id=?",
        "SELECT library_id FROM lyric_scan_batches WHERE id=?",
        "SELECT library_id FROM library_trash WHERE id=?",
        "SELECT t.library_id FROM lyric_lookup_jobs j JOIN tracks t ON t.id=j.track_id WHERE j.id=?",
    ):
        row = connection.execute(query, (identity,)).fetchone()
        if row:
            return row[0]
    row = connection.execute(
        "SELECT t.library_id FROM metadata_suggestions s JOIN tracks t ON t.id=s.track_id WHERE s.id=?",
        (identity,),
    ).fetchone()
    return row[0] if row else None


def object_source(connection, identity):
    row = connection.execute(
        "SELECT s.id FROM intake_items i LEFT JOIN library_sources s "
        "ON s.library_id=i.library_id AND s.root=i.source_root WHERE i.id=?",
        (identity,),
    ).fetchone()
    if row:
        return row[0] or "detached-source"
    draft = connection.execute(
        "SELECT json_extract(payload,'$.item_id') FROM agent_drafts WHERE id=? AND kind='intake'",
        (identity,),
    ).fetchone()
    return object_source(connection, draft[0]) if draft and draft[0] else None


def require_current_library(database, capability="library:read"):
    context = current_library.get()
    if context is None:
        return
    from wildstring.permissions import require_scope

    with database.connect() as db:
        user = db.execute("SELECT * FROM users WHERE id=?", (context.user_id,)).fetchone()
        if user is None or (
            context.library_id and context.library_id not in allowed_ids(db, context.user_id)
        ):
            raise HTTPException(403, "library_access_required")
        require_scope(dict(user), capability)


@contextmanager
def library_job_scope(database, kind, identity, track_id, capability="library:read"):
    with database.connect() as db:
        row = db.execute(
            "SELECT user_id,library_id FROM library_job_owners WHERE kind=? AND id=?",
            (kind, identity),
        ).fetchone()
        if row is None:
            track = db.execute("SELECT library_id FROM tracks WHERE id=?", (track_id,)).fetchone()
            if track is None:
                raise HTTPException(404, "track_not_found")
            user_id, library_id = "admin", track[0]
        else:
            user_id, library_id = row
    with library_context(user_id, library_id):
        require_current_library(database, capability)
        yield


def references(arguments):
    identities = []
    objects = []

    def collect(value):
        if isinstance(value, list):
            for item in value:
                collect(item)
            return
        if not isinstance(value, dict):
            return
        for key, item in value.items():
            if key in {"track_id", "album_id"} and isinstance(item, str):
                identities.append(("id" if key == "track_id" else key, item))
            elif key == "track_ids" and isinstance(item, list):
                identities.extend(
                    ("id", identity) for identity in item if isinstance(identity, str)
                )
            elif key in {"draft_id", "task_id", "item_id", "identity", "id"} and isinstance(
                item, str
            ):
                objects.append(item)
            elif isinstance(item, (dict, list)):
                collect(item)

    collect(arguments)
    return identities, objects


@contextmanager
def actor_library_scope(database, actor, arguments, *, library_id=None, require_selection=False):
    identities, objects = references(arguments)
    previous = current_library.get()
    requested = library_id or (
        previous.library_id if previous and previous.user_id == actor.user_id else None
    )
    selection = requested
    with database.connect() as db:
        visible = allowed_ids(db, actor.user_id)
        for identity in objects:
            target = object_library(db, identity)
            if target:
                if target not in visible:
                    raise HTTPException(404, "library_not_found")
                if library_id and target != library_id:
                    raise HTTPException(404, "library_not_found")
                selection = target
        source = previous.source_id if previous and previous.user_id == actor.user_id else "import"
        for identity in objects:
            source = object_source(db, identity) or source
        libraries = set()
        for field, identity in identities:
            row = db.execute(
                "SELECT library_id FROM tracks WHERE id=? LIMIT 1"
                if field == "id"
                else "SELECT library_id FROM tracks WHERE album_id=? LIMIT 1",
                (identity,),
            ).fetchone()
            if row:
                if row[0] not in visible:
                    raise HTTPException(404, "track_not_found")
                if library_id and row[0] != library_id:
                    raise HTTPException(404, "track_not_found")
                libraries.add(row[0])
        if len(libraries) == 1 and not library_id:
            selection = next(iter(libraries))
        if selection and selection not in visible:
            raise HTTPException(404, "library_not_found")
        if require_selection and selection is None and len(visible) > 1:
            raise HTTPException(422, "library_selection_required")
    with library_context(actor.user_id, selection, source):
        yield


def library_for_root(connection, root):
    if (
        connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='libraries'"
        ).fetchone()
        is None
    ):
        return None
    row = connection.execute("SELECT id,root FROM libraries WHERE root=?", (str(root),)).fetchone()
    if row is None and connection.execute("PRAGMA user_version").fetchone()[0] >= 37:
        row = connection.execute(
            "SELECT l.id,l.root FROM libraries l JOIN library_migrations m ON m.library_id=l.id WHERE m.source_root=? AND m.status='completed' ORDER BY m.created_at DESC LIMIT 1",
            (str(root),),
        ).fetchone()
    return row


def scoped_settings(settings, database, source_id=None):
    context = current_library.get()
    if context is None or context.library_id is None:
        if not database.path.is_file():
            return settings
        with database.connect() as db:
            row = library_for_root(db, settings.library_dir)
        return settings.model_copy(update={"library_dir": Path(row["root"])}) if row else settings
    with database.connect() as db:
        row = db.execute(
            "SELECT root FROM libraries WHERE id=? AND enabled=1", (context.library_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(404, "library_not_found")
        sources = db.execute(
            "SELECT id,root FROM library_sources WHERE library_id=? ORDER BY id",
            (context.library_id,),
        ).fetchall()
        source_id = source_id or context.source_id
        source = next((s for s in sources if s["id"] == source_id), None)
        if source is None and source_id in {"import", "all"} and sources:
            source = sources[0]
        if source is None:
            raise HTTPException(404, "source_not_found")
        return settings.model_copy(
            update={"library_dir": Path(row[0]), "music_dir": Path(source["root"])}
        )
