"""Library administration, read-only import roots and account access grants."""

from pathlib import Path
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from wildstring.library.folders import FolderCreate, browse_folders, create_folder
from wildstring.library.scope import allowed_ids, library_for_root
from wildstring.library.storage import LibraryStorage, MigrationInput, busy


class LibraryInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)
    source_roots: list[Annotated[str, Field(min_length=1, max_length=4096)]] = Field(
        min_length=1, max_length=32
    )
    paused_source_roots: list[str] | None = Field(default=None, max_length=32)
    managed_root: str | None = Field(default=None, min_length=1, max_length=4096)
    default_access: bool | None = Field(default=None, strict=True)


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
                db.execute(
                    "UPDATE libraries SET is_default=1,default_access=1 WHERE id=?", (identity,)
                )
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
            result["default_access"] = bool(record["default_access"])
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
                    "INSERT INTO libraries(id,root,name,default_access) VALUES (?,?,?,?)",
                    (identity, str(root), body.name, bool(body.default_access)),
                )
            elif not db.execute(
                "UPDATE libraries SET name=?,enabled=?,default_access=COALESCE(?,default_access),"
                "version=version+1 WHERE id=? AND version=?",
                (body.name, body.enabled, body.default_access, identity, body.version),
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
        router = APIRouter(prefix="/api/v1/libraries", tags=["libraries"])
        storage = LibraryStorage(self)

        @router.get("/folders", dependencies=[Depends(auth.require_owner)])
        def folders(path: Annotated[str | None, Query(max_length=4096)] = None):
            return browse_folders(self.settings, self.database, path)

        @router.post(
            "/folders",
            dependencies=[Depends(auth.require_owner), Depends(auth.require_client)],
            status_code=201,
        )
        def new_folder(body: FolderCreate):
            return create_folder(self.settings, self.database, body)

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
