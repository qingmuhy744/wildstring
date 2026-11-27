"""Offline tests for scripts/ai_test.py using loopback fake model and HTTP proxy servers."""

from __future__ import annotations

import http.client
import json
import sys
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from pydantic import SecretStr

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import ai_test  # noqa: E402

from wildstring.agent_models import Connection  # noqa: E402
from wildstring.main import create_app  # noqa: E402


@contextmanager
def _fake_gemini_server(*, fail_status: int | None = None):
    received: list[dict] = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):  # noqa: A002
            return

        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            received.append(
                {
                    "path": self.path,
                    "api_key": self.headers.get("x-goog-api-key"),
                    "authorization": self.headers.get("Authorization"),
                    "body": body,
                }
            )
            if fail_status is not None:
                self.send_response(fail_status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"error":{"message":"rejected"}}')
                return

            contents = body.get("contents") or []
            last_parts = contents[-1].get("parts") or [] if contents else []
            last_text = " ".join(
                part.get("text", "") for part in last_parts if isinstance(part, dict)
            )
            has_tool_response = any(
                isinstance(part, dict) and "functionResponse" in part for part in last_parts
            )
            if has_tool_response:
                payload = {
                    "candidates": [
                        {
                            "content": {
                                "role": "model",
                                "parts": [{"text": "Returned wildstring-probe."}],
                            },
                            "finishReason": "STOP",
                        }
                    ],
                    "usageMetadata": {"totalTokenCount": 14},
                }
            elif (
                body.get("tools")
                and ((body.get("toolConfig") or {}).get("functionCallingConfig") or {}).get("mode")
                != "NONE"
            ):
                payload = {
                    "candidates": [
                        {
                            "content": {
                                "role": "model",
                                "parts": [
                                    {
                                        "text": "internal thought",
                                        "thought": True,
                                        "thoughtSignature": "sig-probe-1",
                                    },
                                    {
                                        "functionCall": {
                                            "name": "probe_connection",
                                            "args": {"marker": "wildstring-probe"},
                                        },
                                        "thoughtSignature": "sig-probe-call-1",
                                    },
                                ],
                            },
                            "finishReason": "STOP",
                        }
                    ],
                    "usageMetadata": {"totalTokenCount": 18},
                }
            elif "fixture-track-1" in last_text:
                payload = {
                    "candidates": [
                        {
                            "content": {
                                "role": "model",
                                "parts": [{"text": '{"track_ids":["fixture-track-1"]}'}],
                            },
                            "finishReason": "STOP",
                        }
                    ],
                    "usageMetadata": {"totalTokenCount": 12},
                }
            else:
                payload = {
                    "candidates": [
                        {
                            "content": {"role": "model", "parts": [{"text": "OK"}]},
                            "finishReason": "STOP",
                        }
                    ],
                    "usageMetadata": {"totalTokenCount": 8},
                }
            raw = json.dumps(payload).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1beta", received
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@contextmanager
def _fake_http_proxy(target_port: int, expected_path: str):
    proxied_targets: list[str] = []

    class ProxyHandler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):  # noqa: A002
            return

        def do_POST(self):  # noqa: N802
            proxied_targets.append(self.path)
            length = int(self.headers.get("Content-Length", "0"))
            data = self.rfile.read(length)
            parsed = urlsplit(self.path)
            assert (
                parsed.scheme == "http"
                and parsed.hostname == "127.0.0.1"
                and parsed.port == target_port
                and parsed.path == expected_path
            )
            forward_headers = {
                key: value
                for key, value in self.headers.items()
                if key.lower() not in {"host", "proxy-connection", "content-length"}
            }
            connection = http.client.HTTPConnection("127.0.0.1", target_port, timeout=10)
            try:
                connection.request("POST", expected_path, body=data, headers=forward_headers)
                upstream = connection.getresponse()
                raw = upstream.read()
                self.send_response(upstream.status)
                self.send_header(
                    "Content-Type", upstream.getheader("Content-Type", "application/json")
                )
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            finally:
                connection.close()

    server = ThreadingHTTPServer(("127.0.0.1", 0), ProxyHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", proxied_targets
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_file_connection_and_proxy_parsing(monkeypatch):
    for key in (
        "WILDSTRING_TEST_AI_BASE_URL",
        "WILDSTRING_TEST_AI_MODEL",
        "WILDSTRING_TEST_AI_API_KEY",
        "WILDSTRING_TEST_AI_PROTOCOL",
        "WILDSTRING_TEST_AI_PROVIDER",
        "WILDSTRING_TEST_AI_REASONING_EFFORT",
        "WILDSTRING_TEST_AI_NATIVE_SEARCH",
        "WILDSTRING_TEST_AI_PROXY",
    ):
        monkeypatch.delenv(key, raising=False)

    assert ai_test.file_connection(required=False) is None
    assert ai_test.file_proxy() is None

    monkeypatch.setenv(
        "WILDSTRING_TEST_AI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta"
    )
    monkeypatch.setenv("WILDSTRING_TEST_AI_MODEL", "gemini-2.5-flash")
    monkeypatch.setenv("WILDSTRING_TEST_AI_API_KEY", "synthetic-gemini-key")
    monkeypatch.setenv("WILDSTRING_TEST_AI_PROTOCOL", "gemini")
    monkeypatch.setenv("WILDSTRING_TEST_AI_NATIVE_SEARCH", "true")
    monkeypatch.setenv("WILDSTRING_TEST_AI_PROXY", "http://127.0.0.1:7890")

    config = ai_test.file_connection(required=True)
    assert config is not None
    assert config.protocol == "gemini"
    assert config.provider == "gemini"
    assert config.reasoning_effort == "auto"
    assert config.native_search is True
    assert ai_test.file_proxy() == ("custom", "http://127.0.0.1:7890")

    monkeypatch.setenv("WILDSTRING_TEST_AI_PROXY", "direct")
    assert ai_test.file_proxy() == ("direct", None)

    monkeypatch.setenv("WILDSTRING_TEST_AI_PROXY", "socks5://127.0.0.1:1080")
    with pytest.raises(SystemExit, match="WILDSTRING_TEST_AI_PROXY"):
        ai_test.file_proxy()


def test_sync_connection_is_idempotent_rotates_secrets_and_preserves_ui_connections(tmp_path):
    settings = ai_test.isolated_settings(tmp_path)
    platform = create_app(settings).state.agent_platform
    platform.database.initialize()
    platform.auth.set_password("synthetic-admin-password")
    actor = platform.current_actor("admin")

    manual_id = platform.save_connection(
        actor,
        Connection(
            name="Manual UI Connection",
            base_url="https://manual.example/v1",
            model="manual-model",
            api_key=SecretStr("synthetic-manual-key"),
        ),
    )["id"]

    first = Connection(
        name=ai_test.CONNECTION_NAME,
        base_url="https://generativelanguage.googleapis.com/v1beta",
        model="gemini-2.5-flash",
        api_key=SecretStr("synthetic-key-v1"),
        protocol="gemini",
        provider="gemini",
        reasoning_effort="auto",
        native_search=True,
    )
    conn_id = ai_test.sync_connection(platform, actor, first)
    assert ai_test.sync_connection(platform, actor, first) == conn_id

    rotated = first.model_copy(
        update={
            "api_key": SecretStr("synthetic-key-v2"),
            "protocol": "chat_completions",
            "provider": "generic",
            "native_search": False,
        }
    )
    assert ai_test.sync_connection(platform, actor, rotated) == conn_id

    all_connections = {item["id"]: item for item in platform.connections(actor)}
    assert manual_id in all_connections
    assert all_connections[conn_id]["protocol"] == "chat_completions"
    assert all_connections[conn_id]["native_search"] is False
    with platform.database.connect() as db:
        row = db.execute(
            "SELECT secret_ref FROM agent_connections WHERE id=?", (conn_id,)
        ).fetchone()
    assert platform.read_secret(row["secret_ref"]) == "synthetic-key-v2"


def test_probe_gemini_native_through_local_http_proxy_and_failure_exit(capsys, monkeypatch):
    for key in ("no_proxy", "NO_PROXY"):
        monkeypatch.delenv(key, raising=False)
    secret = "synthetic-gemini-secret-12345"
    expected_path = "/v1beta/models/gemini-2.5-flash:generateContent"
    with _fake_gemini_server() as (base_url, received):
        target_port = urlsplit(base_url).port
        assert target_port is not None
        with _fake_http_proxy(target_port, expected_path) as (
            proxy_url,
            proxied_targets,
        ):
            config = Connection(
                name=ai_test.CONNECTION_NAME,
                base_url=base_url,
                model="gemini-2.5-flash",
                api_key=SecretStr(secret),
                protocol="gemini",
                provider="gemini",
                reasoning_effort="low",
            )
            code = ai_test.probe(config, ("custom", proxy_url))
            out = capsys.readouterr().out
            assert code == 0
            assert "proxy_mode: custom" in out
            assert "text: pass" in out
            assert "structured: pass" in out
            assert "tools: pass" in out
            assert "tools_roundtrip: pass" in out
            assert secret not in out
            assert len(received) == 4
            assert len(proxied_targets) == 4
            assert all(item["path"] == expected_path for item in received)
            assert all(
                item["api_key"] == secret and item["authorization"] is None for item in received
            )
            assert all(secret not in item["path"] for item in received)
            # Verify the roundtrip turn echoed back the model's thoughtSignature verbatim.
            roundtrip_contents = received[-1]["body"]["contents"]
            model_parts = roundtrip_contents[1]["parts"]
            assert any(part.get("thoughtSignature") == "sig-probe-call-1" for part in model_parts)

    with _fake_gemini_server(fail_status=401) as (fail_url, _):
        failing = Connection(
            name=ai_test.CONNECTION_NAME,
            base_url=fail_url,
            model="gemini-2.5-flash",
            api_key=SecretStr(secret),
            protocol="gemini",
            provider="gemini",
            reasoning_effort="auto",
        )
        code = ai_test.probe(failing, ("direct", None))
        out = capsys.readouterr().out
        assert code == 1
        assert "proxy_mode: direct" in out
        assert "text: unverified" in out
        assert "error_code: credentials_rejected" in out
        assert secret not in out
