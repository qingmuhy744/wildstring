"""Backfill directory identities for existing programmes and merge verified duplicates.

The job never trusts a title. Apple is searched by title (and title plus author), but an
iTunes id is stored only when Apple's ``feedUrl`` normalises to the programme's own feed
or to the URL its feed redirects to. Duplicate rows are reported to the owner; only rows
that share such a verified id can be merged, and merging is always an explicit action.

A few minutes after start-up the server runs the job once on its own (see
``schedule_auto``). That run only fills ids for rows that have none; suspected duplicates
it uncovers appear in the duplicate report for a library admin to confirm. It never merges.
"""

import logging
import shutil
import threading
import time
import unicodedata
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from wildstring.library.repository import now
from wildstring.podcast_identity import feed_keys, normalize_feed_url
from wildstring.podcast_search import MANAGE_SCOPE, SearchRateLimited

logger = logging.getLogger(__name__)

# Calls per minute the job leaves to people searching while it runs.
SEARCH_HEADROOM = 5
FEED_FETCH_INTERVAL_SECONDS = 2.0
MAX_RATE_LIMIT_WAIT_SECONDS = 300
DEFAULT_BATCH = 100
MAX_BATCH = 1000
# A show Apple did not list is looked up again only after this long.
NO_MATCH_RETRY_DAYS = 7


def migrate(connection):
    """Schema 46: normalise every stored feed URL and track the identity check per row."""
    connection.execute("BEGIN IMMEDIATE")
    columns = {row[1] for row in connection.execute("PRAGMA table_info(podcasts)")}
    for name in ("itunes_checked_at", "itunes_check_status"):
        if name not in columns:
            connection.execute(f"ALTER TABLE podcasts ADD COLUMN {name} TEXT")  # nosec B608
    rows = connection.execute(
        "SELECT id, feed_url FROM podcasts WHERE feed_url_normalized IS NULL"
    ).fetchall()
    for podcast_id, feed_url in rows:
        connection.execute(
            "UPDATE podcasts SET feed_url_normalized=? WHERE id=?",
            (normalize_feed_url(feed_url) or None, podcast_id),
        )
    connection.execute(
        "UPDATE podcasts SET itunes_check_status='existing' "
        "WHERE itunes_id IS NOT NULL AND itunes_check_status IS NULL"
    )
    connection.execute("PRAGMA user_version=46")
    connection.commit()


def title_key(value: str | None) -> str:
    text = unicodedata.normalize("NFKC", value or "").casefold()
    return "".join(ch for ch in text if ch.isalnum())


class BackfillStart(BaseModel):
    model_config = ConfigDict(extra="forbid")
    limit: int = Field(DEFAULT_BATCH, ge=1, le=MAX_BATCH)
    retry_unmatched: bool = False


class MergeRequest(BaseModel):
    """The pair to merge; the server decides which show is kept (see ``keeper``)."""

    model_config = ConfigDict(extra="forbid")
    podcast_ids: list[Annotated[str, Field(min_length=1, max_length=100)]] = Field(
        min_length=2, max_length=2
    )


class IdentityBackfill:
    """One background run at a time; every row records when and how it was checked."""

    def __init__(
        self,
        manager,
        search,
        *,
        clock: Callable[[], float] = time.monotonic,
        wait: Callable[[float], bool] | None = None,
    ):
        self.manager = manager
        self.database = manager.database
        self.search = search
        self.clock = clock
        self.stop = getattr(manager, "stopping", None) or threading.Event()
        self.wait = wait or self.stop.wait
        self.lock = threading.Lock()
        self.thread: threading.Thread | None = None
        self.auto_thread: threading.Thread | None = None
        self.last_feed_fetch = float("-inf")
        self.run_state: dict[str, Any] = {"running": False, "last_run": None}

    # Status -----------------------------------------------------------------------------
    def status(self) -> dict[str, Any]:
        with self.database.connect() as db:
            counts = {
                row["status"]: row["n"]
                for row in db.execute(
                    """SELECT COALESCE(itunes_check_status, 'unchecked') AS status,
                    COUNT(*) AS n FROM podcasts GROUP BY 1"""
                )
            }
            with_id = db.execute(
                "SELECT COUNT(*) FROM podcasts WHERE itunes_id IS NOT NULL"
            ).fetchone()[0]
        with self.lock:
            state = dict(self.run_state)
        total = sum(counts.values())
        return {
            **state,
            "total": total,
            "with_itunes_id": with_id,
            "unchecked": counts.get("unchecked", 0) + counts.get("failed", 0),
            "counts": counts,
        }

    # Running ----------------------------------------------------------------------------
    def start(
        self, limit: int = DEFAULT_BATCH, retry_unmatched: bool = False, *, trigger: str = "manual"
    ) -> dict[str, Any]:
        with self.lock:
            if self.run_state["running"]:
                raise HTTPException(409, "podcast_identity_backfill_running")
            self.run_state = {
                "running": True,
                "trigger": trigger,
                "started_at": now(),
                "finished_at": None,
                "processed": 0,
                "matched": 0,
                "no_match": 0,
                "failed": 0,
                "ambiguous": 0,
                "paused_until": None,
                "stopped_reason": None,
                "last_run": self.run_state.get("last_run"),
            }
            self.thread = threading.Thread(
                target=self._run_safely,
                args=(limit, retry_unmatched),
                name="podcast-identity-backfill",
                daemon=True,
            )
            self.thread.start()
        return self.status()

    def _run_safely(self, limit: int, retry_unmatched: bool):
        try:
            self.run(limit, retry_unmatched)
        except Exception:
            logger.exception("Podcast identity backfill failed")
            self._finish("error")

    def _bump(self, key: str):
        with self.lock:
            self.run_state[key] = self.run_state.get(key, 0) + 1

    def _finish(self, reason: str):
        try:
            report = self.duplicates()
            found = {"verified": report["verified"], "possible": report["possible"]}
        except Exception:
            logger.exception("Duplicate report failed after identity backfill")
            found = None
        with self.lock:
            summary = {
                key: self.run_state.get(key)
                for key in ("processed", "matched", "no_match", "failed", "ambiguous", "trigger")
            }
            summary["duplicates"] = found
            self.run_state.update(
                running=False,
                finished_at=now(),
                paused_until=None,
                stopped_reason=reason,
                last_run={**summary, "finished_at": now(), "stopped_reason": reason},
            )

    def candidates(self, limit: int, retry_unmatched: bool) -> list[dict[str, Any]]:
        """Rows without an id: unchecked, failed, or unmatched for ``NO_MATCH_RETRY_DAYS``."""
        cutoff = (datetime.now(UTC) - timedelta(days=NO_MATCH_RETRY_DAYS)).isoformat()
        with self.database.connect() as db:
            rows = db.execute(
                """SELECT id, title, author, feed_url, feed_url_normalized,
                resolved_feed_url_normalized, itunes_id FROM podcasts
                WHERE itunes_id IS NULL AND (itunes_check_status IS NULL
                    OR itunes_check_status = 'failed'
                    OR (itunes_check_status = 'no_match' AND (? OR itunes_checked_at IS NULL
                        OR itunes_checked_at < ?)))
                ORDER BY itunes_check_status IS NOT NULL, created_at, id LIMIT ?""",
                (int(retry_unmatched), cutoff, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def schedule_auto(self, delay_seconds: float, limit: int = MAX_BATCH) -> threading.Thread:
        """Run the job once in the background after ``delay_seconds``; never blocks start-up.

        The automatic run only fills missing ids. It skips itself when an admin run is
        already going and exits early when the server shuts down during the delay.
        """

        def wait_then_run():
            if self.stop.wait(max(0.0, delay_seconds)):
                return
            if not self.candidates(1, False):
                logger.info("Automatic podcast identity backfill: nothing to check")
                return
            try:
                self.start(limit, False, trigger="auto")
            except HTTPException:
                logger.info("Automatic podcast identity backfill skipped: a run is in progress")
                return
            logger.info("Automatic podcast identity backfill started")

        thread = threading.Thread(
            target=wait_then_run, name="podcast-identity-auto-backfill", daemon=True
        )
        thread.start()
        self.auto_thread = thread
        return thread

    def run(self, limit: int = DEFAULT_BATCH, retry_unmatched: bool = False) -> dict[str, Any]:
        """Check up to ``limit`` programmes; safe to repeat and to interrupt at any row."""
        with self.lock:
            if not self.run_state.get("running"):
                self.run_state.update(
                    running=True,
                    trigger="manual",
                    started_at=now(),
                    processed=0,
                    matched=0,
                    no_match=0,
                    failed=0,
                    ambiguous=0,
                    paused_until=None,
                )
        reason = "done"
        for row in self.candidates(limit, retry_unmatched):
            if self.stop.is_set():
                reason = "stopped"
                break
            outcome = self.check(row)
            if outcome == "stopped":
                reason = "stopped"
                break
            self._bump("processed")
            self._bump(outcome)
        self._finish(reason)
        return self.status()

    def _resolve(self, row: dict[str, Any]) -> tuple[str | None, bool]:
        """Return the normalised URL the feed redirects to, and whether fetching worked."""
        if row["resolved_feed_url_normalized"]:
            return row["resolved_feed_url_normalized"], True
        from wildstring import podcasts

        delay = self.last_feed_fetch + FEED_FETCH_INTERVAL_SECONDS - self.clock()
        if delay > 0 and self.wait(delay):
            return None, False
        self.last_feed_fetch = self.clock()
        proxy_mode, proxy_url = self.manager.get_network_policy()
        try:
            parsed = podcasts.fetch_and_parse_feed(
                row["feed_url"],
                proxy_mode=proxy_mode,
                proxy_url=proxy_url,
                allow_fake_ip=self.manager.allow_fake_ip,
            )
        except HTTPException:
            return None, False
        except Exception:
            logger.exception("Feed check failed during identity backfill id=%s", row["id"])
            return None, False
        return normalize_feed_url(parsed.get("resolved_url") or row["feed_url"]) or None, True

    def _search(self, term: str, regions: list[str]) -> list[dict[str, Any]] | None:
        """Search within the shared budget, waiting politely; None means stop the run."""
        waited = 0.0
        while True:
            try:
                results, _failed, _cached = self.search.search_directory(
                    term, regions, 25, headroom=SEARCH_HEADROOM
                )
                return results
            except SearchRateLimited as exc:
                delay = min(exc.retry_after, MAX_RATE_LIMIT_WAIT_SECONDS)
                if waited + delay > MAX_RATE_LIMIT_WAIT_SECONDS:
                    return None
                with self.lock:
                    self.run_state["paused_until"] = time.time() + delay
                waited += delay
                if self.wait(delay):
                    return None
                with self.lock:
                    self.run_state["paused_until"] = None

    def check(self, row: dict[str, Any]) -> str:
        normalized = normalize_feed_url(row["feed_url"]) or None
        resolved, fetched = self._resolve(row)
        if self.stop.is_set():
            return "stopped"
        keys = feed_keys(row["feed_url"]) | ({resolved} if resolved else set())
        regions = self.search.settings()["regions"]
        terms = [row["title"].strip()]
        author = (row["author"] or "").strip()
        if author and title_key(author) not in title_key(row["title"]):
            terms.append(f"{terms[0]} {author}")
        ids: list[str] = []
        searched = False
        for term in [t[:200] for t in terms if t]:
            try:
                results = self._search(term, regions)
            except HTTPException:
                results = []
            else:
                searched = True
            if results is None:
                return "stopped"
            ids = sorted(
                {
                    value
                    for item in results
                    if item["_key"] in keys
                    for value in [item["itunes_id"], *item.get("_ids", ())]
                    if value
                },
                key=int,
            )
            if ids:
                break
        if ids:
            status = "matched"
        elif searched:
            status = "no_match"
        else:
            status = "failed"
        with self.database.connect(write=True) as db:
            db.execute(
                """UPDATE podcasts SET feed_url_normalized=?,
                resolved_feed_url_normalized=COALESCE(resolved_feed_url_normalized, ?),
                itunes_id=COALESCE(itunes_id, ?), itunes_check_status=?,
                itunes_checked_at=? WHERE id=?""",
                (normalized, resolved, ids[0] if ids else None, status, now(), row["id"]),
            )
        if len(ids) > 1:
            # Apple lists the same feed under several ids; the oldest listing wins.
            self._bump("ambiguous")
        if not fetched and status == "matched":
            logger.info("Matched podcast id=%s without reaching its feed", row["id"])
        return status

    # Duplicates -------------------------------------------------------------------------
    def _rows(self, db, ids: tuple[str, ...] | None = None) -> list[dict[str, Any]]:
        where = f"WHERE p.id IN ({','.join('?' * len(ids))})" if ids else ""
        rows = [
            dict(row)
            for row in db.execute(
                f"""SELECT p.id, p.title, p.author, p.feed_url, p.cover_url, p.itunes_id,
                p.itunes_check_status, p.created_at, p.publisher_id,
                COALESCE(p.feed_url_normalized, '') AS feed_key,
                COALESCE(p.resolved_feed_url_normalized, '') AS resolved_key,
                (SELECT COUNT(*) FROM podcast_follows f WHERE f.podcast_id=p.id) AS followers,
                (SELECT COUNT(*) FROM podcast_episodes e WHERE e.podcast_id=p.id) AS episodes,
                (SELECT COUNT(*) FROM podcast_episodes e WHERE e.podcast_id=p.id
                    AND e.download_status='downloaded') AS downloaded
                FROM podcasts p {where} ORDER BY p.created_at, p.id""",  # nosec B608
                ids or (),
            )
        ]
        for row in rows:
            row["feed_key"] = row["feed_key"] or normalize_feed_url(row["feed_url"])
            # A feed redirects when the URL it finally answers on differs from its own.
            row["redirects"] = bool(row["resolved_key"]) and row["resolved_key"] != row["feed_key"]
        return rows

    def duplicates(self) -> dict[str, Any]:
        with self.database.connect() as db:
            rows = self._rows(db)
        buckets: dict[tuple[str, str], list[str]] = {}
        by_id = {row["id"]: row for row in rows}
        for row in rows:
            marks = {("feed", key) for key in (row["feed_key"], row["resolved_key"]) if key}
            if row["itunes_id"]:
                marks.add(("itunes_id", row["itunes_id"]))
            if title_key(row["title"]):
                marks.add(("title", title_key(row["title"])))
            for mark in marks:
                buckets.setdefault(mark, []).append(row["id"])
        pairs: dict[tuple[str, str], set[str]] = {}
        for (reason, _value), members in buckets.items():
            for index, first in enumerate(members):
                for second in members[index + 1 :]:
                    if reason == "title" and not self._authors_agree(by_id[first], by_id[second]):
                        continue
                    pairs.setdefault((first, second), set()).add(reason)
        report = []
        for (first, second), reasons in pairs.items():
            a, b = by_id[first], by_id[second]
            verified = bool(a["itunes_id"]) and a["itunes_id"] == b["itunes_id"]
            keep = self.keeper(a, b)
            report.append(
                {
                    "confidence": "verified" if verified else "possible",
                    "reasons": sorted(reasons),
                    "itunes_id": a["itunes_id"] if verified else None,
                    "suggested_keep_id": keep["id"],
                    "podcasts": [self._summary(a), self._summary(b)],
                }
            )
        report.sort(
            key=lambda item: (item["confidence"] != "verified", item["podcasts"][0]["title"])
        )
        return {
            "duplicates": report,
            "verified": sum(item["confidence"] == "verified" for item in report),
            "possible": sum(item["confidence"] == "possible" for item in report),
        }

    @staticmethod
    def _authors_agree(a, b) -> bool:
        first, second = title_key(a["author"]), title_key(b["author"])
        return not first or not second or first == second

    @staticmethod
    def keeper(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
        """The show a merge keeps.

        A show whose own feed URL is final (it does not redirect) wins; when both or neither
        redirect, the one with more followers wins. Downloads, age and id break exact ties
        so the choice is stable.
        """
        return min(
            (a, b),
            key=lambda row: (
                row["redirects"],
                -row["followers"],
                -row["downloaded"],
                row["created_at"] or "",
                row["id"],
            ),
        )

    @staticmethod
    def _summary(row) -> dict[str, Any]:
        return {
            key: row[key]
            for key in (
                "id",
                "title",
                "author",
                "feed_url",
                "cover_url",
                "itunes_id",
                "itunes_check_status",
                "created_at",
                "followers",
                "episodes",
                "downloaded",
                "redirects",
            )
        }

    # Merge ------------------------------------------------------------------------------
    def merge(self, first_id: str, second_id: str) -> dict[str, Any]:
        """Merge a verified pair into the show ``keeper`` picks; the order given is ignored."""
        if first_id == second_id:
            raise HTTPException(422, "podcast_merge_same")
        manager = self.manager
        with self.database.connect() as db:
            shows = {row["id"]: row for row in self._rows(db, (first_id, second_id))}
            if len(shows) != 2:
                raise HTTPException(404, "podcast_not_found")
            keep_id = self.keeper(shows[first_id], shows[second_id])["id"]
            merge_id = second_id if keep_id == first_id else first_id
            if not shows[keep_id]["itunes_id"] or (
                shows[keep_id]["itunes_id"] != shows[merge_id]["itunes_id"]
            ):
                raise HTTPException(409, "podcast_merge_unverified")
            episode_ids = [
                row["id"]
                for row in db.execute(
                    "SELECT id FROM podcast_episodes WHERE podcast_id IN (?, ?)",
                    (keep_id, merge_id),
                )
            ]
            busy = db.execute(
                "SELECT 1 FROM podcast_episodes WHERE podcast_id IN (?, ?) "
                "AND download_status IN ('queued','downloading') LIMIT 1",
                (keep_id, merge_id),
            ).fetchone()
        active = set(getattr(manager, "_active_downloads", {})) | set(
            getattr(manager, "_queued_episodes", {})
        )
        if busy or active.intersection(episode_ids):
            raise HTTPException(409, "podcast_merge_busy")
        stats = {
            "episodes_moved": 0,
            "episodes_matched": 0,
            "progress_moved": 0,
            "progress_replaced": 0,
            "downloads_moved": 0,
            "follows_moved": 0,
        }
        orphans: list[str] = []
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            kept = db.execute(
                "SELECT id, guid, audio_url, local_path, download_status "
                "FROM podcast_episodes WHERE podcast_id=?",
                (keep_id,),
            ).fetchall()
            by_guid = {row["guid"]: row for row in kept}
            by_audio = {row["audio_url"]: row for row in kept if row["audio_url"]}
            moving = db.execute(
                "SELECT id, guid, audio_url, local_path, download_status "
                "FROM podcast_episodes WHERE podcast_id=?",
                (merge_id,),
            ).fetchall()
            for old in moving:
                target = by_guid.get(old["guid"]) or by_audio.get(old["audio_url"])
                if target is None:
                    db.execute(
                        "UPDATE podcast_episodes SET podcast_id=? WHERE id=?", (keep_id, old["id"])
                    )
                    stats["episodes_moved"] += 1
                    stats["downloads_moved"] += old["download_status"] == "downloaded"
                    stats["progress_moved"] += db.execute(
                        "SELECT COUNT(*) FROM podcast_progress WHERE episode_id=?", (old["id"],)
                    ).fetchone()[0]
                    continue
                stats["episodes_matched"] += 1
                self._merge_episode(db, old, target, stats, orphans)
            for table in ("podcast_follows", "podcast_user_catalog", "podcast_user_settings"):
                changed = db.execute(
                    f"UPDATE OR IGNORE {table} SET podcast_id=? WHERE podcast_id=?",  # nosec B608
                    (keep_id, merge_id),
                ).rowcount
                if table == "podcast_follows":
                    stats["follows_moved"] = changed
            db.execute(
                "UPDATE podcasts SET publisher_id=COALESCE(publisher_id, ?) WHERE id=?",
                (shows[merge_id]["publisher_id"], keep_id),
            )
            db.execute("DELETE FROM podcasts WHERE id=?", (merge_id,))
            db.commit()
            referenced = [
                row[0]
                for row in db.execute(
                    "SELECT local_path FROM podcast_episodes WHERE local_path IS NOT NULL"
                )
            ]
        if orphans:
            manager._delete_local_paths(orphans, protected=referenced)
        folder = Path(manager._podcast_dir(merge_id))
        if folder.exists() and not any(
            Path(path).resolve().is_relative_to(folder.resolve()) for path in referenced
        ):
            shutil.rmtree(folder, ignore_errors=True)
        logger.info("Merged podcast %s into %s: %s", merge_id, keep_id, stats)
        return {"kept_id": keep_id, "merged_id": merge_id, **stats}

    @staticmethod
    def _merge_episode(db, old, target, stats, orphans):
        old_id, new_id = old["id"], target["id"]
        for progress in db.execute(
            "SELECT * FROM podcast_progress WHERE episode_id=?", (old_id,)
        ).fetchall():
            current = db.execute(
                "SELECT last_listened_at, version FROM podcast_progress "
                "WHERE episode_id=? AND user_id=?",
                (new_id, progress["user_id"]),
            ).fetchone()
            if current is None:
                db.execute(
                    "UPDATE podcast_progress SET episode_id=? WHERE episode_id=? AND user_id=?",
                    (new_id, old_id, progress["user_id"]),
                )
                stats["progress_moved"] += 1
            elif progress["last_listened_at"] > current["last_listened_at"]:
                db.execute(
                    """UPDATE podcast_progress SET position_seconds=?, duration_seconds=?,
                    completed=?, last_listened_at=?, session_id=?, device_id=?, sequence=?,
                    version=? WHERE episode_id=? AND user_id=?""",
                    (
                        progress["position_seconds"],
                        progress["duration_seconds"],
                        progress["completed"],
                        progress["last_listened_at"],
                        progress["session_id"],
                        progress["device_id"],
                        progress["sequence"],
                        max(progress["version"], current["version"]) + 1,
                        new_id,
                        progress["user_id"],
                    ),
                )
                stats["progress_replaced"] += 1
        db.execute(
            """UPDATE podcast_resource_refs SET
            manual=MAX(manual, (SELECT o.manual FROM podcast_resource_refs o
                WHERE o.episode_id=:old AND o.user_id=podcast_resource_refs.user_id)),
            automatic=MAX(automatic, (SELECT o.automatic FROM podcast_resource_refs o
                WHERE o.episode_id=:old AND o.user_id=podcast_resource_refs.user_id))
            WHERE episode_id=:new AND user_id IN
                (SELECT user_id FROM podcast_resource_refs WHERE episode_id=:old)""",
            {"old": old_id, "new": new_id},
        )
        db.execute(
            """UPDATE podcast_resource_state SET protected=MAX(protected,
                (SELECT o.protected FROM podcast_resource_state o WHERE o.episode_id=:old))
            WHERE episode_id=:new
                AND EXISTS (SELECT 1 FROM podcast_resource_state WHERE episode_id=:old)""",
            {"old": old_id, "new": new_id},
        )
        for table in (
            "podcast_playback_cache",
            "podcast_resource_refs",
            "podcast_resource_state",
            "podcast_resource_leases",
        ):
            db.execute(
                f"UPDATE OR IGNORE {table} SET episode_id=? WHERE episode_id=?",  # nosec B608
                (new_id, old_id),
            )
        if old["local_path"]:
            if target["download_status"] == "downloaded" and target["local_path"]:
                orphans.append(old["local_path"])
            elif old["download_status"] == "downloaded":
                db.execute(
                    "UPDATE podcast_episodes SET local_path=?, download_status='downloaded' "
                    "WHERE id=?",
                    (old["local_path"], new_id),
                )
                stats["downloads_moved"] += 1
            else:
                orphans.append(old["local_path"])
        db.execute("UPDATE podcast_episodes SET local_path=NULL WHERE id=?", (old_id,))

    # HTTP -------------------------------------------------------------------------------
    def routes(self, router: APIRouter, auth) -> None:
        # Owners and library admins share these; ``library:manage`` is the existing scope.
        manager = Annotated[dict, Depends(auth.require_permission(MANAGE_SCOPE))]

        @router.get("/identity/backfill")
        def backfill_status(_user: manager):
            return self.status()

        @router.post(
            "/identity/backfill", status_code=202, dependencies=[Depends(auth.require_client)]
        )
        def start_backfill(_user: manager, body: BackfillStart | None = None):
            body = body or BackfillStart()
            return self.start(body.limit, body.retry_unmatched)

        @router.get("/identity/duplicates")
        def list_duplicates(_user: manager):
            return self.duplicates()

        @router.post("/identity/merge", dependencies=[Depends(auth.require_client)])
        def merge(body: MergeRequest, _user: manager):
            return self.merge(*body.podcast_ids)


__all__ = ["IdentityBackfill", "migrate", "title_key"]
