"""A cross-process, no-burst source gate shared by Python and Node adapters."""

import json
import sqlite3
import sys
import time

from wildstring.source_plugins import PluginError


def permit(policy, clock=None):
    """Reserve at most one request; callers wait outside all DB transactions."""
    now = time.time() if clock is None else clock
    with sqlite3.connect(policy["database"], timeout=10) as db:
        db.execute("BEGIN IMMEDIATE")
        if policy.get("batch_id"):
            row = db.execute(
                "SELECT status FROM lyric_scan_batches WHERE id=?", (policy["batch_id"],)
            ).fetchone()
            if not row or row[0] != "running":
                raise PluginError("lyric_scan_paused")
        row = db.execute(
            "SELECT next_at,cooldown_until,reason,last_at FROM plugin_request_gates WHERE plugin_id=?",
            (policy["plugin_id"],),
        ).fetchone()
        next_at, cooldown, reason, last_at = row if row else (0, 0, None, 0)
        if cooldown > now:
            raise PluginError(reason or "source_plugin_rate_limited")
        interval = max(1, min(120, float(policy.get("interval_seconds", 5))))
        next_at = max(next_at, last_at + interval) if row else 0
        if next_at > now:
            return min(0.25, next_at - now)
        db.execute(
            "INSERT INTO plugin_request_gates(plugin_id,next_at,last_at) VALUES (?,?,?) ON CONFLICT(plugin_id) DO UPDATE SET next_at=excluded.next_at,last_at=excluded.last_at",
            (policy["plugin_id"], now + interval, now),
        )
    return 0


def wait(policy, deadline=None):
    if not policy:
        return
    deadline = deadline or time.monotonic() + max(45, float(policy.get("interval_seconds", 5)) + 15)
    while True:
        delay = permit(policy)
        if not delay:
            return
        if time.monotonic() + delay > deadline:
            raise PluginError("source_plugin_timeout")
        time.sleep(delay)


def cooldown(policy, delay=900, reason="source_plugin_rate_limited"):
    if policy:
        with sqlite3.connect(policy["database"], timeout=10) as db:
            db.execute(
                "INSERT INTO plugin_request_gates(plugin_id,cooldown_until,reason) VALUES (?,?,?) ON CONFLICT(plugin_id) DO UPDATE SET cooldown_until=max(cooldown_until,excluded.cooldown_until),reason=excluded.reason",
                (policy["plugin_id"], time.time() + max(1, min(86400, delay)), reason),
            )


def main():
    try:
        wait(json.loads(sys.stdin.buffer.read(8192)))
        print(json.dumps({"ok": True}))
    except PluginError as error:
        print(json.dumps({"error": error.code}))


if __name__ == "__main__":
    main()
