"""Agent contracts shared by routes and service mixins, without platform imports."""

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from pydantic import ValidationError

from wildstring.agent_diagnostics import DEFINITIONS as DIAGNOSTIC_TOOLS
from wildstring.agent_models import SCOPES


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def future(seconds):
    return (datetime.now(UTC) + timedelta(seconds=seconds)).isoformat()


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def validate(model, value):
    try:
        return model.model_validate(value)
    except (ValidationError, TypeError, ValueError):
        raise HTTPException(422, "agent_invalid_input") from None


@dataclass(frozen=True)
class Actor:
    user_id: str
    role: str
    version: int
    scopes: frozenset[str] = frozenset(SCOPES)
    credential_id: str | None = None

    def require(self, scope, *, admin=False):
        if scope not in self.scopes or (admin and self.role != "admin"):
            raise HTTPException(
                403, "agent_scope_required" if scope not in self.scopes else "admin_required"
            )


TOOLS = {
    "search_tracks": (
        "搜索真实曲库歌曲",
        "library:read",
        True,
        {"q": "string", "limit": "integer", "offset": "integer"},
    ),
    "search_albums": (
        "搜索曲库专辑",
        "library:read",
        True,
        {"q": "string", "limit": "integer", "offset": "integer"},
    ),
    "search_artists": (
        "搜索曲库艺人",
        "library:read",
        True,
        {"q": "string", "limit": "integer", "offset": "integer"},
    ),
    "get_track": (
        "读取真实歌曲和元数据版本，不含音频路径",
        "library:read",
        True,
        {"track_id": "string"},
    ),
    "get_personal_library": (
        "读取本人收藏、歌单或收听历史",
        "personal:read",
        True,
        {"kind": "string", "limit": "integer", "offset": "integer"},
    ),
    "inspect_library": (
        "有界只读本地元数据巡检",
        "library:read",
        True,
        {"track_ids": "array", "limit": "integer"},
    ),
    "create_draft": (
        "生成待站内确认的歌单或元数据草案，不修改曲库",
        "drafts:write",
        False,
        {"kind": "string", "title": "string", "payload": "object", "evidence": "array"},
    ),
    "get_draft": ("读取本人草案", "drafts:write", True, {"draft_id": "string"}),
    "apply_draft": (
        "应用已在站内批准的具体草案版本",
        "drafts:apply",
        False,
        {"draft_id": "string", "version": "integer", "idempotency_key": "string"},
    ),
    "submit_inspection": (
        "提交持久巡检，默认本地规则；显式开启AI并选择连接和预算时会调用模型并可能计费，结果不自动应用",
        "tasks:write",
        False,
        {
            "track_ids": "array",
            "max_tracks": "integer",
            "max_calls": "integer",
            "use_ai": "boolean",
            "connection_id": "string",
        },
    ),
    "get_task": ("读取本人巡检任务及 checkpoint", "tasks:write", True, {"task_id": "string"}),
    "cancel_task": ("协作取消本人任务", "tasks:write", False, {"task_id": "string"}),
    "list_notifications": (
        "读取本人站内通知，不改变已读状态",
        "notifications:read",
        True,
        {"limit": "integer", "offset": "integer"},
    ),
}


TOOLS.update(DIAGNOSTIC_TOOLS)

TOOLS.update(
    {
        "get_metadata_suggestions": (
            "读取已有联网元数据候选及证据，不自动查询或应用",
            "library:read",
            True,
            {"track_id": "string"},
        ),
        "request_metadata_refresh": (
            "管理员提交指定歌曲的联网候选查询，不应用结果",
            "tasks:write",
            False,
            {"track_ids": "array", "force": "boolean"},
        ),
    }
)


def tool_definitions():
    required = {
        "get_track": ["track_id"],
        "get_metadata_suggestions": ["track_id"],
        "request_metadata_refresh": ["track_ids"],
        "get_draft": ["draft_id"],
        "apply_draft": ["draft_id", "version", "idempotency_key"],
        "create_draft": ["kind", "title", "payload"],
        "get_task": ["task_id"],
        "cancel_task": ["task_id"],
        "get_personal_library": ["kind"],
        "get_operation_trace": ["trace_id"],
        "get_task_diagnostics": ["task_id"],
    }
    return [
        {
            "name": name,
            "description": desc,
            "scope": scope,
            "read_only": readonly,
            "input_schema": {
                "type": "object",
                "properties": {
                    key: {
                        "type": value,
                        **(
                            {"items": {"type": "string"}}
                            if value == "array" and key == "track_ids"
                            else {"items": {"type": "object"}}
                            if value == "array"
                            else {}
                        ),
                    }
                    for key, value in properties.items()
                },
                "required": required.get(name, []),
                "additionalProperties": False,
            },
        }
        for name, (desc, scope, readonly, properties) in TOOLS.items()
    ]
