"""Chat Completions policy shared by connection probes and actual selection."""

from wildstring.outbound import json_request


def completion(config, body, providers=None):
    mode, proxy = "environment", None
    if providers is not None:
        mode = providers.settings()["proxy_mode"]
        proxy = providers.secrets().get("proxy_url")
    headers = {"User-Agent": "WildString/0.4.0"}
    if config.get("api_key"):
        headers["Authorization"] = "Bearer " + config["api_key"]
    return json_request(
        config["base_url"].rstrip("/") + "/chat/completions",
        payload=body,
        headers=headers,
        timeout=config["timeout"],
        proxy_mode=mode,
        proxy_url=proxy,
        service="ai",
        limit=65536,
    )


def content(response):
    result = response["choices"][0]["message"]["content"]
    if not isinstance(result, str) or not result.strip():
        raise ValueError("invalid_model_response")
    return result
