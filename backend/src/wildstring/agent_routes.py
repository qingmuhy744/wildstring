"""Authenticated UI routes and an independently scoped tool transport."""

from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request

from wildstring.agent_models import (
    Apply,
    AssistantPreferences,
    Connection,
    ConversationCreate,
    CredentialCreate,
    DraftCreate,
    DraftPatch,
    EndpointPolicy,
    Inspection,
    MessageCreate,
    NotificationPreferences,
    NotificationRead,
    ReadAll,
    Retry,
    Schedule,
    TargetState,
    TelegramCreate,
    Verify,
    Version,
)
from wildstring.agent_platform import SCOPES, tool_definitions


def page(items, limit=100, offset=0):
    return {
        "items": items[offset : offset + limit],
        "total": len(items),
        "limit": limit,
        "offset": offset,
    }


def agent_router(service):
    router = APIRouter(prefix="/api/v1/agent", tags=["agent"])

    def session(request: Request):
        actor = service.actor(request, session_only=True)
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            service.auth.require_client(request)
        return actor

    def transport_actor(request: Request):
        return service.actor(request)

    @router.get("/capabilities")
    def capabilities(actor: Annotated[object, Depends(transport_actor)]):
        return {
            "version": 1,
            "scopes": list(SCOPES),
            "tools": tool_definitions(),
            "features": {
                "drafts": True,
                "notifications": True,
                "telegram": True,
                "inspections": True,
                "schedules": True,
                "assistant": True,
            },
            "role": actor.role,
        }

    @router.get("/tools")
    def tools(actor: Annotated[object, Depends(transport_actor)]):
        return {
            "tools": [
                {
                    "name": tool["name"],
                    "description": tool["description"],
                    "inputSchema": tool["input_schema"],
                    "annotations": {
                        "readOnlyHint": tool["read_only"],
                        "destructiveHint": False,
                        "idempotentHint": tool["read_only"] or tool["name"] == "apply_draft",
                        "openWorldHint": tool["name"]
                        in {
                            "request_metadata_refresh",
                            "test_external_services",
                            "submit_inspection",
                        },
                    },
                }
                for tool in tool_definitions()
                if tool["scope"] in actor.scopes
            ]
        }

    @router.post("/tools/{name}")
    def tool(
        name: str,
        request: Request,
        actor: Annotated[object, Depends(transport_actor)],
        arguments: object = Body(...),
    ):
        if not actor.credential_id:
            service.auth.require_client(request)
        trace_id = getattr(request.state, "trace_id", None) or uuid4().hex
        result = service.execute_tool(actor, name, arguments)
        service.log("agent.tool.executed", actor, trace_id=trace_id, tool=name)
        return {"result": result, "trace_id": trace_id}

    @router.get("/credentials")
    def credentials(
        actor: Annotated[object, Depends(session)],
        limit: int = Query(50, ge=1, le=100),
        offset: int = Query(0, ge=0, le=1000000),
    ):
        return page(service.credentials(actor), limit, offset)

    @router.post("/credentials")
    def create_credential(body: CredentialCreate, actor: Annotated[object, Depends(session)]):
        return service.create_credential(actor, body)

    @router.delete("/credentials/{identity}")
    def revoke_credential(identity: str, actor: Annotated[object, Depends(session)]):
        return service.revoke_credential(actor, identity)

    @router.get("/drafts")
    def drafts(
        actor: Annotated[object, Depends(session)],
        limit: int = Query(50, ge=1, le=100),
        offset: int = Query(0, ge=0, le=1000000),
        status: str | None = Query(None, max_length=30),
    ):
        return service.drafts(actor, limit, offset, status)

    @router.post("/drafts")
    def create_draft(body: DraftCreate, actor: Annotated[object, Depends(session)]):
        return service.create_draft(actor, body)

    @router.get("/drafts/{identity}")
    def draft(identity: str, actor: Annotated[object, Depends(session)]):
        return service.draft(actor, identity)

    @router.patch("/drafts/{identity}")
    def patch_draft(identity: str, body: DraftPatch, actor: Annotated[object, Depends(session)]):
        return service.patch_draft(actor, identity, body)

    @router.post("/drafts/{identity}/approve")
    def approve(identity: str, body: Version, actor: Annotated[object, Depends(session)]):
        return service.approve_draft(actor, identity, body.version)

    @router.post("/drafts/{identity}/reject")
    def reject(identity: str, body: Version, actor: Annotated[object, Depends(session)]):
        return service.approve_draft(actor, identity, body.version, reject=True)

    @router.post("/drafts/{identity}/apply")
    def apply(identity: str, body: Apply, actor: Annotated[object, Depends(session)]):
        return service.apply_draft(actor, identity, body)

    @router.get("/notifications")
    def notifications(
        actor: Annotated[object, Depends(session)],
        limit: int = Query(50, ge=1, le=100),
        offset: int = Query(0, ge=0, le=1000000),
        cursor: str | None = Query(None, max_length=128),
    ):
        return service.notifications(actor, limit=limit, offset=offset, cursor=cursor)

    @router.post("/notifications/read")
    def read(body: NotificationRead, actor: Annotated[object, Depends(session)]):
        return service.mark_read(actor, identities=body.ids)

    @router.post("/notifications/read-all")
    def read_all(body: ReadAll, actor: Annotated[object, Depends(session)]):
        return service.mark_read(actor, high_watermark=body.high_watermark)

    @router.get("/notification-preferences")
    def preferences(actor: Annotated[object, Depends(session)]):
        return service.preferences(actor)

    @router.put("/notification-preferences")
    def update_preferences(
        body: NotificationPreferences, actor: Annotated[object, Depends(session)]
    ):
        return service.set_preferences(actor, body)

    @router.get("/telegram-targets")
    def targets(
        actor: Annotated[object, Depends(session)],
        limit: int = Query(50, ge=1, le=100),
        offset: int = Query(0, ge=0, le=1000000),
    ):
        return page(service.targets(actor), limit, offset)

    @router.post("/telegram-targets")
    def create_target(body: TelegramCreate, actor: Annotated[object, Depends(session)]):
        return service.create_target(actor, body)

    @router.post("/telegram-targets/{identity}/verify-send")
    def verify_send(identity: str, actor: Annotated[object, Depends(session)]):
        return service.verify_send(actor, identity)

    @router.post("/telegram-targets/{identity}/verify")
    def verify(identity: str, body: Verify, actor: Annotated[object, Depends(session)]):
        return service.verify_target(actor, identity, body.code)

    @router.post("/telegram-targets/{identity}/test")
    def test_target(identity: str, actor: Annotated[object, Depends(session)]):
        target = service.target(actor, identity)
        if not target["verified"]:
            raise HTTPException(409, "telegram_target_unverified")
        try:
            message_id = service.send_telegram(
                target, "野弦通知测试：目标已验证。此消息不代表任何任务已完成。"
            )
        except HTTPException:
            raise
        except Exception as failure:
            raise HTTPException(502, getattr(failure, "code", "telegram_test_failed")) from None
        return {"ok": True, "message_id": message_id, "scope": "target_delivery"}

    @router.patch("/telegram-targets/{identity}")
    def update_target(identity: str, body: TargetState, actor: Annotated[object, Depends(session)]):
        return service.update_target(actor, identity, body)

    @router.delete("/telegram-targets/{identity}")
    def delete_target(identity: str, actor: Annotated[object, Depends(session)]):
        return service.delete_target(actor, identity)

    @router.get("/deliveries")
    def deliveries(
        actor: Annotated[object, Depends(session)],
        limit: int = Query(50, ge=1, le=100),
        offset: int = Query(0, ge=0, le=1000000),
    ):
        return service.deliveries(actor, limit, offset)

    @router.post("/deliveries/{identity}/retry")
    def retry(identity: str, body: Retry, actor: Annotated[object, Depends(session)]):
        return service.retry_delivery(actor, identity, body.acknowledge_unknown)

    @router.get("/tasks")
    def tasks(
        actor: Annotated[object, Depends(session)],
        limit: int = Query(50, ge=1, le=100),
        offset: int = Query(0, ge=0, le=1000000),
    ):
        return service.tasks(actor, limit, offset)

    @router.post("/tasks")
    def submit(body: Inspection, actor: Annotated[object, Depends(session)]):
        return service.submit_task(actor, body, manual=True)

    @router.get("/tasks/{identity}")
    def task(identity: str, actor: Annotated[object, Depends(session)]):
        return service.task(actor, identity)

    @router.post("/tasks/{identity}/cancel")
    def cancel(identity: str, actor: Annotated[object, Depends(session)]):
        return service.cancel_task(actor, identity)

    @router.post("/tasks/{identity}/resume")
    def resume(identity: str, actor: Annotated[object, Depends(session)]):
        return service.resume_task(actor, identity)

    @router.get("/schedules")
    def schedules(
        actor: Annotated[object, Depends(session)],
        limit: int = Query(50, ge=1, le=100),
        offset: int = Query(0, ge=0, le=1000000),
    ):
        return page(service.schedules(actor), limit, offset)

    @router.post("/schedules")
    def create_schedule(body: Schedule, actor: Annotated[object, Depends(session)]):
        return service.save_schedule(actor, body)

    @router.patch("/schedules/{identity}")
    def update_schedule(identity: str, body: Schedule, actor: Annotated[object, Depends(session)]):
        return service.save_schedule(actor, body, identity)

    @router.delete("/schedules/{identity}")
    def delete_schedule(identity: str, actor: Annotated[object, Depends(session)]):
        return service.delete_schedule(actor, identity)

    @router.get("/endpoint-policy")
    def endpoint_policy(actor: Annotated[object, Depends(session)]):
        actor.require("diagnostics:read", admin=True)
        return service.endpoint_policy()

    @router.put("/endpoint-policy")
    def save_policy(body: EndpointPolicy, actor: Annotated[object, Depends(session)]):
        return service.save_endpoint_policy(actor, body)

    @router.get("/connections")
    def connections(
        actor: Annotated[object, Depends(session)],
        limit: int = Query(50, ge=1, le=100),
        offset: int = Query(0, ge=0, le=1000000),
    ):
        return page(service.connections(actor), limit, offset)

    @router.post("/connections")
    def create_connection(body: Connection, actor: Annotated[object, Depends(session)]):
        return service.save_connection(actor, body)

    @router.patch("/connections/{identity}")
    def patch_connection(
        identity: str, body: Connection, actor: Annotated[object, Depends(session)]
    ):
        return service.save_connection(actor, body, identity)

    @router.delete("/connections/{identity}")
    def delete_connection(identity: str, actor: Annotated[object, Depends(session)]):
        return service.delete_connection(actor, identity)

    @router.post("/connections/{identity}/test")
    def test_connection(identity: str, actor: Annotated[object, Depends(session)]):
        return service.test_connection(actor, identity)

    @router.get("/assistant-preferences")
    def assistant_preferences(actor: Annotated[object, Depends(session)]):
        return service.assistant_preferences(actor)

    @router.put("/assistant-preferences")
    def save_assistant_preferences(
        body: AssistantPreferences, actor: Annotated[object, Depends(session)]
    ):
        return service.save_assistant_preferences(actor, body)

    @router.get("/conversations")
    def conversations(
        actor: Annotated[object, Depends(session)],
        limit: int = Query(50, ge=1, le=100),
        offset: int = Query(0, ge=0, le=1000000),
    ):
        return page(service.conversations(actor), limit, offset)

    @router.post("/conversations")
    def create_conversation(body: ConversationCreate, actor: Annotated[object, Depends(session)]):
        return service.create_conversation(actor, body)

    @router.get("/conversations/{identity}")
    def conversation(identity: str, actor: Annotated[object, Depends(session)]):
        return service.conversation(actor, identity)

    @router.delete("/conversations/{identity}")
    def delete_conversation(identity: str, actor: Annotated[object, Depends(session)]):
        return service.delete_conversation(actor, identity)

    @router.delete("/conversations")
    def delete_conversations(actor: Annotated[object, Depends(session)]):
        return service.delete_conversation(actor)

    @router.post("/conversations/{identity}/messages")
    def message(identity: str, body: MessageCreate, actor: Annotated[object, Depends(session)]):
        return service.send_message(actor, identity, body)

    return router
