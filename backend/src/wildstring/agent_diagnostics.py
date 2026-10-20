"""Explicit diagnostic tools; never an arbitrary log/file/HTTP endpoint."""

import json
import re
from importlib.metadata import version

from fastapi import HTTPException

DEFINITIONS = {
    "get_system_status": ("读取服务版本、数据库及诊断状态", "diagnostics:read", True, {}),
    "search_log_events": (
        "分页查询脱敏结构化事件，仅管理员",
        "diagnostics:read",
        True,
        {
            "limit": "integer",
            "cursor": "string",
            "trace_id": "string",
            "level": "string",
            "event": "string",
            "task_id": "string",
        },
    ),
    "get_operation_trace": (
        "按诊断编号查询操作事件，仅管理员",
        "diagnostics:read",
        True,
        {"trace_id": "string", "limit": "integer"},
    ),
    "get_task_diagnostics": (
        "读取本人任务和关联诊断事件，仅管理员",
        "diagnostics:read",
        True,
        {"task_id": "string", "limit": "integer"},
    ),
    "test_external_services": (
        "用已保存代理检查固定外部依赖，不修改配置或曲库",
        "diagnostics:read",
        False,
        {},
    ),
}


def legacy_task(service, identity):
    """Read fixed legacy task projections; raw results can contain music paths."""
    with service.database.connect() as connection:
        row = connection.execute(
            "SELECT id,kind,status,created_at,started_at,finished_at,error,result,import_id FROM admin_jobs WHERE id=? AND library_id=?",
            (identity, service.library_id),
        ).fetchone()
        if row is not None:
            result = {
                key: row[key]
                for key in ("id", "kind", "status", "created_at", "started_at", "finished_at")
            }
            if row["result"]:
                try:
                    data = json.loads(row["result"])
                    counts = data.get("counts", {}) if isinstance(data, dict) else {}
                    result["counts"] = {
                        key: value
                        for key, value in counts.items()
                        if re.fullmatch(r"[a-z_]{1,40}", key) and type(value) is int
                    }
                except (ValueError, AttributeError):
                    result["counts"] = {}
            if row["import_id"] and row["status"] in {"queued", "running"}:
                current = connection.execute(
                    "SELECT counts FROM import_runs WHERE id=?", (row["import_id"],)
                ).fetchone()
                if current:
                    result["counts"] = {
                        key: value
                        for key, value in json.loads(current[0]).items()
                        if re.fullmatch(r"[a-z_]{1,40}", key) and type(value) is int
                    }
            result["error_code"] = safe_code(row["error"])
            return result, identity.replace("-", "")
        row = connection.execute(
            "SELECT j.id,j.track_id,j.status,j.attempts,j.created_at,j.updated_at,j.error,j.metadata_version FROM provider_jobs j JOIN tracks t ON t.id=j.track_id WHERE j.id=? AND t.library_id=?",
            (identity, service.library_id),
        ).fetchone()
        if row is not None:
            return {
                key: row[key]
                for key in (
                    "id",
                    "track_id",
                    "status",
                    "attempts",
                    "created_at",
                    "updated_at",
                    "metadata_version",
                )
            } | {
                "kind": "metadata_source_query",
                "error_code": safe_code(row["error"]),
            }, identity.replace("-", "")
        row = connection.execute(
            "SELECT id,total,created_at FROM provider_refresh_batches WHERE id=? AND library_id=?",
            (identity, service.library_id),
        ).fetchone()
        if row is not None:
            from wildstring.provider_batches import SELECTION

            counts = dict(
                connection.execute(
                    "".join(("SELECT status,count(*) FROM (", SELECTION, ") GROUP BY status")),
                    (identity,),
                ).fetchall()
            )
            result = dict(row) | {
                "kind": "metadata_refresh_batch",
                "counts": counts,
                "status": "running"
                if counts.get("running") or counts.get("queued")
                else "partial"
                if counts.get("failed") or counts.get("stale")
                else "completed",
            }
            return result, identity
    raise HTTPException(404, "agent_task_not_found")


def safe_code(value):
    return (
        value
        if isinstance(value, str) and re.fullmatch(r"[a-z0-9_]{1,100}", value)
        else "task_failed"
        if value
        else None
    )


def execute(service, actor, name, arguments):
    actor.require("diagnostics:read", admin=True)
    for key, value in arguments.items():
        if key != "limit" and (
            not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,100}", value)
        ):
            raise HTTPException(422, "agent_invalid_input")
    if service.diagnostics is None:
        raise HTTPException(503, "diagnostics_unavailable")
    if name == "get_system_status":
        with service.database.connect() as connection:
            schema = connection.execute("PRAGMA user_version").fetchone()[0]
        return {
            "version": version("wildstring-backend"),
            "schema_version": schema,
            "logging": service.diagnostics.status(),
        }
    if name == "search_log_events":
        return service.diagnostics.events(**arguments)
    if name == "get_operation_trace":
        if "trace_id" not in arguments:
            raise HTTPException(422, "agent_invalid_input")
        return service.diagnostics.events(**arguments)
    if name == "get_task_diagnostics":
        if "task_id" not in arguments:
            raise HTTPException(422, "agent_invalid_input")
        try:
            task = service.task(actor, arguments["task_id"])
            trace = task["trace_id"]
        except HTTPException as failure:
            if failure.status_code != 404:
                raise
            task, trace = legacy_task(service, arguments["task_id"])
        return {
            "task": task,
            "diagnostics": service.diagnostics.events(
                trace_id=trace, limit=arguments.get("limit", 50)
            ),
        }
    from wildstring.provider_network import test_network
    from wildstring.providers import Providers

    providers = getattr(service, "providers", None) or Providers(service.repository)
    if not providers.network_test_lock.acquire(blocking=False):
        raise HTTPException(409, "network_test_running")
    try:
        config, secrets = providers.settings(), providers.secrets()
        return test_network(config["proxy_mode"], secrets.get("proxy_url"), secrets, providers)
    finally:
        providers.network_test_lock.release()
