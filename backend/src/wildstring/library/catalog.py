"""Library identities, read-only import roots and account access grants."""

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field


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


def migrate(connection):
    connection.execute("BEGIN IMMEDIATE")
    columns = {r[1] for r in connection.execute("PRAGMA table_info(libraries)")}
    for name, definition in (
        ("name", "TEXT NOT NULL DEFAULT '音乐库'"),
        ("enabled", "INTEGER NOT NULL DEFAULT 1"),
        ("is_default", "INTEGER NOT NULL DEFAULT 0"),
        ("version", "INTEGER NOT NULL DEFAULT 1"),
    ):
        if name not in columns:
            connection.execute(f"ALTER TABLE libraries ADD COLUMN {name} {definition}")
    connection.execute("""CREATE TABLE IF NOT EXISTS library_sources (
        library_id TEXT NOT NULL REFERENCES libraries(id), id TEXT NOT NULL,
        root TEXT NOT NULL, PRIMARY KEY(library_id,id), UNIQUE(library_id,root))""")
    connection.execute("""CREATE TABLE IF NOT EXISTS user_library_access (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        library_id TEXT NOT NULL REFERENCES libraries(id), PRIMARY KEY(user_id,library_id))""")
    connection.execute("""CREATE TABLE IF NOT EXISTS library_access_versions (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        version INTEGER NOT NULL DEFAULT 1)""")
    connection.execute("""INSERT OR IGNORE INTO user_library_access
        SELECT u.id,l.id FROM users u CROSS JOIN libraries l""")
    connection.execute("""UPDATE libraries SET name=COALESCE(
        (SELECT name FROM library_preferences p WHERE p.library_id=libraries.id),name)""")
    connection.execute("""CREATE TABLE IF NOT EXISTS podcast_follows (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        podcast_id TEXT NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,podcast_id))""")
    connection.execute("""CREATE TABLE IF NOT EXISTS library_job_owners (
        kind TEXT NOT NULL, id TEXT NOT NULL, user_id TEXT NOT NULL,
        library_id TEXT NOT NULL REFERENCES libraries(id), PRIMARY KEY(kind,id))""")
    # All interpolated schema identifiers below come from fixed internal tuples.
    for table in ("agent_tasks", "agent_schedules"):
        columns = {r[1] for r in connection.execute(f"PRAGMA table_info({table})")}
        if "library_id" not in columns:
            connection.execute(
                f"ALTER TABLE {table} ADD COLUMN library_id TEXT REFERENCES libraries(id)"
            )
        connection.execute(
            f"UPDATE {table} SET library_id=(SELECT library_id FROM tracks WHERE id=json_extract({table}.parameters,'$.track_ids[0]')) WHERE library_id IS NULL"  # nosec B608
        )
        connection.execute(
            f"UPDATE {table} SET library_id=(SELECT id FROM libraries ORDER BY is_default DESC,id LIMIT 1) WHERE library_id IS NULL"  # nosec B608
        )
        connection.execute(f"""CREATE TRIGGER IF NOT EXISTS {table}_library_scope AFTER INSERT ON {table}
            WHEN NEW.library_id IS NULL BEGIN UPDATE {table} SET library_id=active_library() WHERE id=NEW.id; END""")  # nosec B608
    for table, identity in (
        ("provider_jobs", "id"),
        ("lyric_lookup_jobs", "id"),
        ("loudness_analysis", "track_id"),
    ):
        connection.execute(
            f"""INSERT OR IGNORE INTO library_job_owners
            SELECT ?,j.{identity},'admin',t.library_id FROM {table} j JOIN tracks t ON t.id=j.track_id""",  # nosec B608
            (table,),
        )
        connection.execute(f"""CREATE TRIGGER IF NOT EXISTS {table}_library_owner AFTER INSERT ON {table}
            BEGIN INSERT OR REPLACE INTO library_job_owners(kind,id,user_id,library_id)
            SELECT '{table}',NEW.{identity},active_user(),t.library_id FROM tracks t WHERE t.id=NEW.track_id; END""")  # nosec B608
    connection.execute("""INSERT OR IGNORE INTO library_job_owners
        SELECT 'lyric_scan_batches',id,'admin',library_id FROM lyric_scan_batches""")
    connection.execute("""CREATE TRIGGER IF NOT EXISTS lyric_scan_batches_library_owner
        AFTER INSERT ON lyric_scan_batches BEGIN
        INSERT OR REPLACE INTO library_job_owners(kind,id,user_id,library_id)
        VALUES ('lyric_scan_batches',NEW.id,active_user(),NEW.library_id); END""")
    columns = {r[1] for r in connection.execute("PRAGMA table_info(admin_jobs)")}
    if "created_by" not in columns:
        connection.execute(
            "ALTER TABLE admin_jobs ADD COLUMN created_by TEXT NOT NULL DEFAULT 'admin'"
        )
    if "source_id" not in columns:
        connection.execute(
            "ALTER TABLE admin_jobs ADD COLUMN source_id TEXT NOT NULL DEFAULT 'import'"
        )
    view = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type='view' AND name='personal_tracks'"
    ).fetchone()[0]
    if "library_visible(t.library_id)" not in view:
        connection.execute("DROP VIEW personal_tracks")
        connection.execute(view.rstrip("; ") + " WHERE library_visible(t.library_id)")
    connection.execute("PRAGMA user_version=36")
    connection.commit()


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
def actor_library_scope(database, actor, arguments, *, library_id=None):
    identities, objects = references(arguments)
    previous = current_library.get()
    selection = library_id or (
        previous.library_id if previous and previous.user_id == actor.user_id else None
    )
    with database.connect() as db:
        visible = allowed_ids(db, actor.user_id)
        for identity in objects:
            target = object_library(db, identity)
            if target:
                if target not in visible:
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
                libraries.add(row[0])
        if len(libraries) == 1:
            selection = next(iter(libraries))
        if selection and selection not in visible:
            raise HTTPException(404, "library_not_found")
    with library_context(actor.user_id, selection, source):
        yield


class LibraryInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)
    source_roots: list[Annotated[str, Field(min_length=1, max_length=4096)]] = Field(
        min_length=1, max_length=32
    )
    paused_source_roots: list[str] | None = Field(default=None, max_length=32)
    managed_root: str | None = Field(default=None, min_length=1, max_length=4096)


class LibraryUpdate(LibraryInput):
    version: int = Field(ge=1, strict=True)
    enabled: bool = True


class AccessUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1, strict=True)
    library_ids: list[str] = Field(max_length=1000)


class LibraryCatalog:
    def __init__(self, database, settings):
        self.database, self.settings = database, settings

    def initialize(self):
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            row = library_for_root(db, self.settings.library_dir)
            identity = row[0] if row else uuid4().hex
            initial = db.execute("SELECT 1 FROM libraries WHERE is_default=1").fetchone() is None
            if row is None:
                db.execute(
                    "INSERT OR IGNORE INTO libraries(id,root,name,is_default) VALUES (?,?,'默认音乐库',?)",
                    (identity, str(self.settings.library_dir), initial),
                )
            if initial:
                db.execute("UPDATE libraries SET is_default=1 WHERE id=?", (identity,))
                db.execute(
                    "INSERT OR IGNORE INTO user_library_access SELECT id,? FROM users", (identity,)
                )
            if (
                db.execute(
                    "SELECT 1 FROM library_sources WHERE library_id=?", (identity,)
                ).fetchone()
                is None
            ):
                db.execute(
                    "INSERT INTO library_sources(library_id,id,root) VALUES (?,'import',?)",
                    (identity, str(self.settings.music_dir)),
                )

    def default_id(self):
        with self.database.connect() as db:
            row = db.execute(
                "SELECT id FROM libraries WHERE is_default=1 ORDER BY id LIMIT 1"
            ).fetchone()
            return row[0] if row else None

    def record(self, identity, *, user_id=None):
        with self.database.connect() as db:
            if user_id is not None and identity not in allowed_ids(db, user_id):
                raise HTTPException(404, "library_not_found")
            row = db.execute("SELECT * FROM libraries WHERE id=?", (identity,)).fetchone()
            if row is None:
                raise HTTPException(404, "library_not_found")
            result = dict(row)
            result["sources"] = [
                dict(r)
                for r in db.execute(
                    "SELECT id,root,watch_enabled FROM library_sources WHERE library_id=? ORDER BY id",
                    (identity,),
                )
            ]
            return result

    def listing(self, user, include_disabled=False):
        with self.database.connect() as db:
            ids = allowed_ids(db, user["id"])
            rows = db.execute(
                "SELECT id FROM libraries ORDER BY is_default DESC,name,id"
            ).fetchall()
        all_libraries = include_disabled and user["profile"] == "owner"
        return [
            self.public(self.record(r[0]), owner=user["profile"] == "owner")
            for r in rows
            if all_libraries or r[0] in ids
        ]

    @staticmethod
    def public(record, *, owner=False):
        result = {k: record[k] for k in ("id", "name", "enabled", "is_default", "version")}
        result["enabled"] = bool(result["enabled"])
        result["is_default"] = bool(result["is_default"])
        if owner:
            result["sources"] = record["sources"]
            result["managed_root"] = record["root"]
        return result

    def roots(self, values, managed_root):
        try:
            roots = [Path(value).expanduser().resolve() for value in values]
        except (OSError, RuntimeError, ValueError):
            raise HTTPException(422, "library_source_invalid") from None
        if any(
            not Path(value).is_absolute() or not root.is_dir()
            for value, root in zip(values, roots, strict=True)
        ):
            raise HTTPException(422, "library_source_invalid")
        with self.database.connect() as db:
            managed = [Path(r[0]) for r in db.execute("SELECT root FROM libraries")]
            managed += [
                Path(r[0])
                for r in db.execute(
                    "SELECT target_root FROM library_migrations WHERE status IN ('queued','running')"
                )
            ]
            managed += [
                Path(r[0])
                for r in db.execute(
                    "SELECT source_root FROM library_migrations WHERE status='completed'"
                )
            ]
        for index, root in enumerate(roots):
            if any(
                root.is_relative_to(other) or other.is_relative_to(root) for other in roots[:index]
            ):
                raise HTTPException(422, "library_sources_overlap")
            if any(
                root.is_relative_to(other) or other.is_relative_to(root)
                for other in [
                    *managed,
                    managed_root,
                    self.settings.data_dir,
                    self.settings.podcasts_dir,
                ]
            ):
                raise HTTPException(422, "library_sources_overlap")
        return roots

    def save(self, body, identity=None):
        from wildstring.library.storage import LibraryStorage, busy

        creating = identity is None
        identity = identity or uuid4().hex
        old = None if creating else self.record(identity)
        root = Path(old["root"]) if old else self.settings.data_dir / "libraries" / identity
        if old and body.managed_root and Path(body.managed_root).resolve() != root:
            raise HTTPException(409, "library_migration_required")
        if not old and body.managed_root:
            root = LibraryStorage(self).destination(body.managed_root, body.source_roots)
        roots = self.roots(body.source_roots, root)
        paused = {str(Path(p).resolve()) for p in body.paused_source_roots or []}
        if not paused <= {str(p) for p in roots}:
            raise HTTPException(422, "library_source_invalid")
        if old and old["is_default"] and not body.enabled:
            raise HTTPException(409, "default_library_required")
        try:
            root.mkdir(parents=True, exist_ok=True)
        except OSError:
            raise HTTPException(503, "library_storage_unavailable") from None
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            if busy(db, identity):
                raise HTTPException(409, "library_migration_busy")
            # A migration destination may have been reserved since the first check.
            self.roots(body.source_roots, root)
            if creating:
                LibraryStorage(self).available(db, root)
                db.execute(
                    "INSERT INTO libraries(id,root,name) VALUES (?,?,?)",
                    (identity, str(root), body.name),
                )
            elif not db.execute(
                "UPDATE libraries SET name=?,enabled=?,version=version+1 WHERE id=? AND version=?",
                (body.name, body.enabled, identity, body.version),
            ).rowcount:
                raise HTTPException(409, "library_version_conflict")
            db.execute(
                "INSERT INTO library_preferences(library_id,name) VALUES (?,?) "
                "ON CONFLICT(library_id) DO UPDATE SET name=excluded.name,version=version+1",
                (identity, body.name),
            )
            previous = {
                r["root"]: dict(r)
                for r in db.execute(
                    "SELECT id,root,watch_enabled FROM library_sources WHERE library_id=?",
                    (identity,),
                )
            }
            db.execute("DELETE FROM library_sources WHERE library_id=?", (identity,))
            db.executemany(
                "INSERT INTO library_sources(library_id,id,root,watch_enabled) VALUES (?,?,?,?)",
                [
                    (
                        identity,
                        previous.get(str(p), {}).get("id", uuid4().hex),
                        str(p),
                        int(str(p) not in paused)
                        if body.paused_source_roots is not None
                        else previous.get(str(p), {}).get("watch_enabled", 1),
                    )
                    for p in roots
                ],
            )
            db.execute("UPDATE library_access_versions SET version=version+1")
        return self.public(self.record(identity), owner=True)

    def access(self, user_id):
        with self.database.connect() as db:
            if db.execute("SELECT id FROM users WHERE id=?", (user_id,)).fetchone() is None:
                raise HTTPException(404, "user_not_found")
            row = db.execute(
                "SELECT version FROM library_access_versions WHERE user_id=?", (user_id,)
            ).fetchone()
            return {
                "version": row[0] if row else 1,
                "library_ids": sorted(allowed_ids(db, user_id)),
            }

    def set_access(self, user_id, body):
        self.access(user_id)
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            if (
                db.execute("SELECT profile FROM users WHERE id=?", (user_id,)).fetchone()[0]
                == "owner"
            ):
                raise HTTPException(409, "owner_library_access_implicit")
            db.execute(
                "INSERT OR IGNORE INTO library_access_versions(user_id) VALUES (?)", (user_id,)
            )
            if not db.execute(
                "UPDATE library_access_versions SET version=version+1 WHERE user_id=? AND version=?",
                (user_id, body.version),
            ).rowcount:
                raise HTTPException(409, "library_access_version_conflict")
            ids = set(body.library_ids)
            available = {r[0] for r in db.execute("SELECT id FROM libraries WHERE enabled=1")}
            if not ids <= available:
                raise HTTPException(404, "library_not_found")
            db.execute(
                "DELETE FROM user_library_access WHERE user_id=? "
                "AND library_id IN (SELECT id FROM libraries WHERE enabled=1)",
                (user_id,),
            )
            db.executemany(
                "INSERT INTO user_library_access VALUES (?,?)", [(user_id, i) for i in ids]
            )
        return self.access(user_id)

    def router(self, auth):
        from wildstring.library.storage import LibraryStorage, MigrationInput

        router = APIRouter(prefix="/api/v1/libraries", tags=["libraries"])
        storage = LibraryStorage(self)

        @router.get("")
        def listing(
            user: Annotated[dict, Depends(auth.require_session)], include_disabled: bool = False
        ):
            return self.listing(user, include_disabled)

        @router.post(
            "",
            dependencies=[Depends(auth.require_owner), Depends(auth.require_client)],
            status_code=201,
        )
        def create(body: LibraryInput):
            return self.save(body)

        @router.put(
            "/{identity}", dependencies=[Depends(auth.require_owner), Depends(auth.require_client)]
        )
        def update(identity: str, body: LibraryUpdate):
            return self.save(body, identity)

        @router.get("/{identity}/migrations", dependencies=[Depends(auth.require_owner)])
        def migrations(identity: str):
            return storage.listing(identity)

        @router.post(
            "/{identity}/migrations", dependencies=[Depends(auth.require_client)], status_code=202
        )
        def migrate(
            identity: str, body: MigrationInput, user: Annotated[dict, Depends(auth.require_owner)]
        ):
            return storage.submit(identity, body, user)

        @router.post(
            "/{identity}/migrations/{job_id}/retry",
            dependencies=[Depends(auth.require_client)],
            status_code=202,
        )
        def retry(identity: str, job_id: str, user: Annotated[dict, Depends(auth.require_owner)]):
            return storage.retry(identity, job_id, user)

        @router.get("/access/{user_id}", dependencies=[Depends(auth.require_owner)])
        def access(user_id: str):
            return self.access(user_id)

        @router.put(
            "/access/{user_id}",
            dependencies=[Depends(auth.require_owner), Depends(auth.require_client)],
        )
        def access_update(user_id: str, body: AccessUpdate):
            return self.set_access(user_id, body)

        return router


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
