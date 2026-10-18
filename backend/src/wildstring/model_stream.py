"""Bounded SSE adapters; only public answer text is sent to the conversation preview."""

import json
import time
from urllib.error import HTTPError
from urllib.request import Request

from wildstring.outbound import OutboundError, request_bytes


def collect(response, limit, protocol, on_text, deadline):
    if "text/event-stream" not in response.headers.get("Content-Type", ""):
        raw = response.read(limit + 1)
        if len(raw) > limit:
            raise OutboundError("response_too_large")
        return json.loads(raw)
    message = {"role": "assistant", "content": ""}
    calls, usage = {}, None
    finish, completed, total = None, None, 0
    text, pending = "", []

    def events():
        nonlocal total
        while True:
            if time.monotonic() >= deadline:
                raise OutboundError("timeout")
            line = response.readline(65537)
            if not line:
                break
            total += len(line)
            if len(line) > 65536 or total > limit:
                raise OutboundError("response_too_large")
            line = line.decode("utf-8").rstrip("\r\n")
            if line.startswith("data:"):
                pending.append(line[5:].lstrip(" "))
            elif not line and pending:
                yield "\n".join(pending)
                pending.clear()
        if pending:
            yield "\n".join(pending)

    for raw in events():
        if raw == "[DONE]":
            break
        event = json.loads(raw)
        if not isinstance(event, dict) or event.get("error") or event.get("type") == "error":
            raise OutboundError("ai_response_failed")
        if protocol == "responses":
            kind = event.get("type")
            if kind == "response.output_text.delta":
                text += event.get("delta", "")
                on_text(text)
            elif kind in {"response.completed", "response.incomplete", "response.failed"}:
                completed = event.get("response")
            continue
        if isinstance(event.get("usage"), dict):
            usage = event["usage"]
        choices = event.get("choices") or []
        if not choices:
            continue
        choice = next((c for c in choices if c.get("index", 0) == 0), None)
        if choice is None:
            continue
        delta = choice.get("delta") or {}
        for key in ("content", "reasoning_content"):
            if isinstance(delta.get(key), str):
                message[key] = message.get(key, "") + delta[key]
        if delta.get("content"):
            on_text(message["content"])
        if isinstance(delta.get("extra_content"), dict):
            message["extra_content"] = delta["extra_content"]
        for part in delta.get("tool_calls") or []:
            index = part.get("index")
            if type(index) is not int or not 0 <= index < 8:
                raise OutboundError("ai_tool_limit")
            call = calls.setdefault(
                index, {"type": "function", "function": {"name": "", "arguments": ""}}
            )
            if part.get("id"):
                call["id"] = part["id"]
            if isinstance(part.get("extra_content"), dict):
                call["extra_content"] = part["extra_content"]
            for key in ("name", "arguments"):
                value = (part.get("function") or {}).get(key)
                if isinstance(value, str):
                    call["function"][key] += value
        if choice.get("finish_reason") is not None:
            finish = choice["finish_reason"]
    if protocol == "responses":
        if not isinstance(completed, dict):
            raise OutboundError("ai_output_incomplete")
        return completed
    if finish is None:
        raise OutboundError("ai_output_incomplete")
    if calls:
        message["tool_calls"] = [calls[key] for key in sorted(calls)]
    return {"choices": [{"message": message, "finish_reason": finish}], "usage": usage}


def stream_request(
    url, *, payload, headers, timeout, proxy_mode, proxy_url, service, on_text, protocol
):
    body = payload | {"stream": True}
    if protocol != "responses":
        body["stream_options"] = {"include_usage": True}
    request = Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode(),
        headers={
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
            **headers,
        },
    )
    deadline = time.monotonic() + timeout
    try:
        _, _, result = request_bytes(
            request,
            timeout=timeout,
            proxy_mode=proxy_mode,
            proxy_url=proxy_url,
            service=service,
            consume=lambda response, limit: collect(response, limit, protocol, on_text, deadline),
        )
        return result
    except HTTPError as error:
        error.close()
        raise OutboundError(
            "rate_limited"
            if error.code == 429
            else "credentials_rejected"
            if error.code in {401, 403}
            else "http_error",
            error.code,
        ) from None
    except (ValueError, UnicodeError, RecursionError, TypeError, AttributeError):
        raise OutboundError("ai_invalid_response") from None
