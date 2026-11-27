"""Wire adapters preserve provider continuation state independently of business tools."""

import json
import re

from wildstring.outbound import OutboundError

GEMINI_MODEL_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")
GEMINI_25_THINKING_BUDGETS = {
    "none": 0,
    "low": 1024,
    "medium": 8192,
    "high": 24576,
    "xhigh": 24576,
}
GEMINI_FILTERED_REASONS = {
    "SAFETY",
    "RECITATION",
    "BLOCKLIST",
    "PROHIBITED_CONTENT",
    "SPII",
    "IMAGE_SAFETY",
}
GEMINI_FAILED_REASONS = {
    "MALFORMED_FUNCTION_CALL",
    "UNEXPECTED_TOOL_CALL",
    "OTHER",
    "LANGUAGE",
}


def options(config):
    value = config.get("options", {})
    return json.loads(value) if isinstance(value, str) else value


def gemini_model_id(model):
    model_id = str(model or "").removeprefix("models/")
    if not GEMINI_MODEL_PATTERN.fullmatch(model_id):
        raise OutboundError("invalid_ai_model")
    return model_id


def _gemini_tool_response_payload(content):
    if isinstance(content, dict):
        return content
    try:
        parsed = json.loads(content) if isinstance(content, str) else content
    except (TypeError, ValueError):
        return {"result": content if content is not None else ""}
    return parsed if isinstance(parsed, dict) else {"result": parsed}


def _gemini_request(config, messages, tools, tool_choice, settings, effort, budget):
    model_id = gemini_model_id(config.get("model"))
    system_texts = []
    contents = []
    call_meta: dict[str, tuple[str, bool]] = {}
    last_was_tool_turn = False

    for message in messages:
        role = message.get("role")
        if role == "system":
            text = message.get("content")
            if isinstance(text, str) and text:
                system_texts.append(text)
            continue
        if role == "assistant":
            last_was_tool_turn = False
            raw_parts = message.get("_gemini_parts")
            if isinstance(raw_parts, list) and raw_parts:
                parts = list(raw_parts)
                tool_calls = message.get("tool_calls") or []
                fc_index = 0
                for part in parts:
                    fc = part.get("functionCall") if isinstance(part, dict) else None
                    if not isinstance(fc, dict):
                        continue
                    raw_id = fc.get("id")
                    has_id = isinstance(raw_id, str) and bool(raw_id)
                    name = str(fc.get("name") or "")
                    if has_id:
                        call_meta[raw_id] = (name, True)
                    elif fc_index < len(tool_calls) and isinstance(tool_calls[fc_index], dict):
                        synth_id = tool_calls[fc_index].get("id")
                        if isinstance(synth_id, str) and synth_id:
                            call_meta[synth_id] = (name, False)
                    fc_index += 1
            else:
                parts = []
                text = message.get("content")
                if isinstance(text, str) and text:
                    parts.append({"text": text})
                for call in message.get("tool_calls") or []:
                    if not isinstance(call, dict):
                        continue
                    fn = call.get("function") or {}
                    name = str(fn.get("name") or "")
                    try:
                        args = json.loads(fn.get("arguments") or "{}")
                    except (TypeError, ValueError):
                        args = {}
                    if not isinstance(args, dict):
                        args = {}
                    fc = {"name": name, "args": args}
                    call_id = call.get("id")
                    if isinstance(call_id, str) and call_id:
                        call_meta[call_id] = (name, False)
                    parts.append({"functionCall": fc})
            if parts:
                contents.append({"role": "model", "parts": parts})
            continue
        if role == "tool":
            call_id = message.get("tool_call_id")
            fn_name, had_id = call_meta.get(
                call_id, (message.get("name") or call_id or "tool", False)
            )
            response_part: dict = {
                "name": fn_name,
                "response": _gemini_tool_response_payload(message.get("content")),
            }
            if had_id and isinstance(call_id, str) and call_id:
                response_part["id"] = call_id
            part = {"functionResponse": response_part}
            if last_was_tool_turn and contents:
                contents[-1]["parts"].append(part)
            else:
                contents.append({"role": "user", "parts": [part]})
                last_was_tool_turn = True
            continue
        last_was_tool_turn = False
        contents.append({"role": "user", "parts": [{"text": message.get("content") or ""}]})

    generation_config: dict = {"maxOutputTokens": budget}
    if effort != "auto":
        if "gemini-2.5" in model_id.lower():
            if effort in GEMINI_25_THINKING_BUDGETS:
                generation_config["thinkingConfig"] = {
                    "thinkingBudget": GEMINI_25_THINKING_BUDGETS[effort]
                }
        elif effort == "none":
            generation_config["thinkingConfig"] = {"thinkingBudget": 0}
        elif effort in {"low", "medium", "high", "xhigh"}:
            generation_config["thinkingConfig"] = {"thinkingLevel": effort}

    body: dict = {"contents": contents, "generationConfig": generation_config}
    if system_texts:
        body["systemInstruction"] = {"parts": [{"text": "\n\n".join(system_texts)}]}

    gemini_tools = []
    if tools:
        declarations = []
        for tool in tools:
            fn = tool["function"]
            decl: dict = {"name": fn["name"], "description": fn.get("description") or ""}
            if fn.get("parameters") is not None:
                decl["parametersJsonSchema"] = fn["parameters"]
            declarations.append(decl)
        gemini_tools.append({"functionDeclarations": declarations})
        if tool_choice == "none":
            body["toolConfig"] = {"functionCallingConfig": {"mode": "NONE"}}
    if settings.get("native_search") and tool_choice != "none":
        gemini_tools.append({"googleSearch": {}})
    if gemini_tools:
        body["tools"] = gemini_tools

    return f"/models/{model_id}:generateContent", body


def _gemini_parse(response):
    candidates = response.get("candidates")
    feedback = response.get("promptFeedback")
    if isinstance(feedback, dict) and feedback.get("blockReason") and not candidates:
        raise OutboundError("ai_content_filtered")
    if not isinstance(candidates, list) or not candidates or not isinstance(candidates[0], dict):
        raise OutboundError("ai_invalid_response")
    candidate = candidates[0]
    reason = candidate.get("finishReason")
    if reason == "MAX_TOKENS":
        raise OutboundError("ai_output_limit")
    if reason in GEMINI_FILTERED_REASONS:
        raise OutboundError("ai_content_filtered")
    if reason in GEMINI_FAILED_REASONS:
        raise OutboundError("ai_response_failed")
    content = candidate.get("content")
    parts = content.get("parts") if isinstance(content, dict) else None
    if not isinstance(parts, list):
        raise OutboundError("ai_invalid_response")
    text_parts = []
    calls = []
    for index, part in enumerate(parts):
        if not isinstance(part, dict):
            continue
        if isinstance(part.get("text"), str) and not part.get("thought"):
            text_parts.append(part["text"])
        fc = part.get("functionCall")
        if isinstance(fc, dict):
            raw_id = fc.get("id")
            call_id = raw_id if isinstance(raw_id, str) and raw_id else f"gemini-call-{index}"
            args = fc.get("args")
            calls.append(
                {
                    "id": call_id,
                    "type": "function",
                    "function": {
                        "name": fc.get("name", ""),
                        "arguments": json.dumps(
                            args if isinstance(args, dict) else {}, ensure_ascii=False
                        ),
                    },
                }
            )
    sources = []
    grounding = candidate.get("groundingMetadata")
    if isinstance(grounding, dict):
        for chunk in grounding.get("groundingChunks") or []:
            web = chunk.get("web") if isinstance(chunk, dict) else None
            if isinstance(web, dict) and web.get("uri"):
                sources.append({"url": web["uri"], "title": web.get("title") or "网页来源"})
    return {
        "role": "assistant",
        "content": "".join(text_parts),
        "tool_calls": calls,
        "_gemini_parts": parts,
        "_sources": sources,
    }


def request(config, messages, tools=None, tool_choice="auto"):
    settings = options(config)
    protocol = settings.get("protocol", "chat_completions")
    provider = settings.get("provider", "generic")
    effort = settings.get("reasoning_effort", "auto")
    budget = settings.get("max_output_tokens", 2048)
    if protocol == "gemini":
        return _gemini_request(config, messages, tools, tool_choice, settings, effort, budget)
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
    protocol = options(config).get("protocol", "chat_completions")
    if protocol == "gemini":
        return _gemini_parse(response)
    if protocol != "responses":
        choices = response.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            raise OutboundError("ai_invalid_response")
        choice = choices[0]
        reason = choice.get("finish_reason")
        if reason in {"length", "content_filter", "insufficient_system_resource", "aborted"}:
            raise OutboundError(
                "ai_output_limit"
                if reason == "length"
                else "ai_content_filtered"
                if reason == "content_filter"
                else "ai_response_failed"
            )
        message = choice.get("message")
        if not isinstance(message, dict):
            raise OutboundError("ai_invalid_response")
        return message
    status = response.get("status")
    if status == "incomplete":
        reason = (response.get("incomplete_details") or {}).get("reason")
        raise OutboundError(
            "ai_output_limit"
            if reason == "max_output_tokens"
            else "ai_content_filtered"
            if reason == "content_filter"
            else "ai_output_incomplete"
        )
    if status in {"failed", "cancelled"}:
        raise OutboundError("ai_response_failed")
    if status in {"in_progress", "queued"}:
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
        for key in ("reasoning_content", "extra_content", "_response_items", "_gemini_parts")
        if key in message
    }
