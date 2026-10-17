"""Real server listening windows and aggregate-only shared-library popularity."""

import time
from typing import Literal

from wildstring.library.repository import now

Scope = Literal["personal", "community"]
Period = Literal["7d", "30d", "90d", "all"]
Metric = Literal["plays", "listened_ms"]


def statistics(repository, scope="personal", period="30d"):
    user = repository.database.user_id if scope == "personal" else None
    with repository.database.connect() as connection:
        if period == "all":
            rows = connection.execute(
                "SELECT s.track_id,sum(s.play_count) AS play_count,sum(s.listened_ms) AS listened_ms "
                "FROM user_track_state s JOIN tracks t ON t.id=s.track_id JOIN users u ON u.id=s.user_id "
                "WHERE t.library_id=? AND t.status='available' AND u.enabled=1 AND (? IS NULL OR s.user_id=?) "
                "GROUP BY s.track_id HAVING sum(s.play_count)>0 OR sum(s.listened_ms)>0",
                (repository.library_id(), user, user),
            ).fetchall()
        else:
            cutoff = time.time() - {"7d": 7, "30d": 30, "90d": 90}[period] * 86400
            rows = connection.execute(
                "SELECT s.track_id,sum(s.counted) AS play_count,sum(s.reported_ms) AS listened_ms "
                "FROM listening_sessions s JOIN tracks t ON t.id=s.track_id JOIN users u ON u.id=s.user_id "
                "WHERE t.library_id=? AND t.status='available' AND u.enabled=1 AND s.started_at>=? "
                "AND (? IS NULL OR s.user_id=?) GROUP BY s.track_id "
                "HAVING sum(s.counted)>0 OR sum(s.reported_ms)>0",
                (repository.library_id(), cutoff, user, user),
            ).fetchall()
    return {
        row["track_id"]: {"play_count": row["play_count"], "listened_ms": row["listened_ms"]}
        for row in rows
    }


def rankings(repository, scope="personal", period="30d", metric="plays", limit=20, offset=0):
    stats = statistics(repository, scope, period)
    field = "play_count" if metric == "plays" else "listened_ms"
    identities = sorted(
        stats,
        key=lambda identity: (-stats[identity][field], -stats[identity]["listened_ms"], identity),
    )
    reason = ("你的" if scope == "personal" else "曲库用户汇总的") + (
        "累计收听统计" if period == "all" else f"近{period[:-1]}天实际收听记录"
    )
    items = []
    for index, identity in enumerate(identities[offset : offset + limit], start=offset + 1):
        track = repository.track(identity)
        if track is not None:
            track.pop("path", None)
            items.append({"rank": index, "track": track, **stats[identity], "reason": reason})
    return {
        "items": items,
        "total": len(identities),
        "limit": limit,
        "offset": offset,
        "scope": scope,
        "period": period,
        "metric": metric,
        "generated_at": now(),
        "evidence": "all_time_aggregate" if period == "all" else "server_session_start_window",
    }
