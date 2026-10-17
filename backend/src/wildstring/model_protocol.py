"""Wire adapters preserve provider continuation state independently of business tools."""

import json

from wildstring.outbound import OutboundError


def options(config):
    value = config.get("options", {})
    return json.loads(value) if isinstance(value, str) else value


def request(config, messages, tools=None, tool_choice="auto"):
    settings = options(config)
    protocol = settings.get("protocol", "chat_completions")
    provider = settings.get("provider", "generic")
    effort = settings.get("reasoning_effort", "auto")
    budget = settings.get("max_output_tokens", 2048)
    body = {"model": config["model"], "stream": False}
    if protocol == "responses":
        items = []
        for message in messages:
            if "_response_items" in message:
                items.extend(message["_response_items"])
            elif message["role"] == "tool":
                items.append(
                    {
                        "type": "function_call_output",
                        "call_id": message["tool_call_id"],
                        "output": message["content"],
                    }
                )
            else:
                items.append({"role": message["role"], "content": message.get("content") or ""})
        body.update(input=items, max_output_tokens=budget, store=False)
        if provider == "openai":
            body["include"] = ["reasoning.encrypted_content"]
        if tools:
            body["tools"] = [{"type": "function", **tool["function"]} for tool in tools]
            if provider == "openai":
                for tool in body["tools"]:
                    tool["strict"] = False
            body["tool_choice"] = tool_choice
        if settings.get("native_search") and tools and tool_choice != "none":
            body.setdefault("tools", []).append({"type": "web_search"})
            if provider == "openai":
                body["include"].append("web_search_call.action.sources")
        if effort != "auto":
            body["reasoning"] = {"effort": effort}
        return "/responses", body
    body.update(
        messages=[
            {k: v for k, v in message.items() if not k.startswith("_")} for message in messages
        ],
        max_tokens=budget,
    )
    if provider == "openai":
        body["max_completion_tokens"] = body.pop("max_tokens")
    if tools:
        body.update(tools=tools, tool_choice=tool_choice)
    if effort != "auto":
        if provider == "deepseek":
            body["thinking"] = {"type": "disabled" if effort == "none" else "enabled"}
            if effort != "none":
                body["reasoning_effort"] = effort
        elif provider == "qwen":
            body["enable_thinking"] = effort != "none"
        else:
            body["reasoning_effort"] = effort
    return "/chat/completions", body


def parse(config, response):
    if not isinstance(response, dict) or response.get("error"):
        raise OutboundError("ai_invalid_response")
    if options(config).get("protocol", "chat_completions") != "responses":
        choices = response.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            raise OutboundError("ai_invalid_response")
        choice = choices[0]
        if choice.get("finish_reason") in {"length", "content_filter"}:
            raise OutboundError("ai_output_incomplete")
        message = choice.get("message")
        if not isinstance(message, dict):
            raise OutboundError("ai_invalid_response")
        return message
    if response.get("status") in {"failed", "incomplete", "cancelled", "in_progress", "queued"}:
        raise OutboundError("ai_output_incomplete")
    output = response.get("output")
    if not isinstance(output, list) or not all(isinstance(item, dict) for item in output):
        raise OutboundError("ai_invalid_response")
    text, calls, sources = [], [], []
    for item in output:
        if item.get("type") == "function_call":
            calls.append(
                {
                    "id": item.get("call_id"),
                    "type": "function",
                    "function": {"name": item.get("name"), "arguments": item.get("arguments")},
                }
            )
        elif item.get("type") == "message":
            for part in item.get("content") or []:
                if part.get("type") == "output_text":
                    text.append(part.get("text", ""))
                    for citation in part.get("annotations") or []:
                        if citation.get("type") == "url_citation":
                            sources.append(
                                {
                                    "url": citation.get("url"),
                                    "title": citation.get("title", "网页来源"),
                                }
                            )
        elif item.get("type") == "web_search_call":
            sources.extend((item.get("action") or {}).get("sources") or [])
    return {
        "role": "assistant",
        "content": "\n".join(text),
        "tool_calls": calls,
        "_response_items": output,
        "_sources": sources,
    }


def continuation(message):
    """Copy only response-owned protocol fields; no client can submit this state."""
    return {
        key: message[key]
        for key in ("reasoning_content", "extra_content", "_response_items")
        if key in message
    }
