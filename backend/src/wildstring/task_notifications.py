"""Bridge shared-library task results to the common transactional inbox.

Historical jobs have no personal owner. Only active administrators receive
their shared-library summaries; individual listening or other users' data never
enters these events. Metadata is summarized once per explicitly requested batch.
"""

from collections import Counter


def admins(connection):
    return [
        row[0]
        for row in connection.execute(
            "SELECT id FROM users WHERE enabled=1 AND role='admin' AND password_hash IS NOT NULL"
        )
    ]


def management_result(service, connection, job, status):
    platform = getattr(service, "platform", None)
    if platform is None:
        return
    for owner in admins(connection):
        platform.emit(
            connection,
            owner,
            "library.task.completed",
            f"library:{job['id']}:{owner}",
            "导入任务结束" if job["kind"] == "import" else "扫描任务结束",
            "任务已完成，请到曲库管理查看逐项结果。"
            if status in {"succeeded", "completed", "success"}
            else "任务已结束，存在需要处理的项目，请到曲库管理查看结果。",
            severity="info" if status in {"succeeded", "completed", "success"} else "warning",
            trace_id=job["id"].replace("-", ""),
            counts={"total": 1, "completed": int(status in {"succeeded", "completed", "success"})},
        )


def metadata_result(service, connection, job_id):
    platform = getattr(service, "platform", None)
    if platform is None:
        return
    from wildstring.provider_batches import SELECTION

    batches = [
        row[0]
        for row in connection.execute(
            "SELECT batch_id FROM provider_refresh_members WHERE job_id=?", (job_id,)
        )
    ]
    for identity in batches:
        rows = connection.execute(SELECTION, (identity,)).fetchall()
        counts = Counter(row["status"] for row in rows)
        if counts["queued"] or counts["running"]:
            continue
        warnings = sum(bool(row["error"] or row["warnings"] not in {"[]", ""}) for row in rows)
        summary = f"查询结束：建议已生成 {counts['completed']} 首，未匹配 {counts['no_match']} 首，失败 {counts['failed']} 首，已变化 {counts['stale']} 首。建议需要确认后应用。"
        if warnings:
            summary += f"其中 {warnings} 首有来源警告。"
        for owner in admins(connection):
            platform.emit(
                connection,
                owner,
                "metadata.refresh.completed",
                f"metadata:{identity}:{owner}",
                "元数据查询结束",
                summary,
                severity="warning" if warnings or counts["failed"] or counts["stale"] else "info",
                trace_id=identity,
                counts=dict(counts) | {"total": len(rows), "warnings": warnings},
            )
