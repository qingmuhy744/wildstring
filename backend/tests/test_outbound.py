"""A real HTTP proxy proves probes and actual work share transport policies."""

import json
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from test_personal_library import HEADERS, music
from test_providers import enable

from wildstring.library.scanner import scan_library
from wildstring.outbound import OutboundError, json_request


@contextmanager
def proxy_server():
    calls = []
    state = {"status": 200, "location": None}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            calls.append((self.path, dict(self.headers), data))
            messages = data.get("messages", [])
            if data.get("tools") and data.get("tool_choice") == "none":
                content = "wildstring-probe"
            elif data.get("tools"):
                response = {
                    "tool_calls": [
                        {
                            "id": "probe-call",
                            "type": "function",
                            "function": {
                                "name": "probe_connection",
                                "arguments": '{"marker":"wildstring-probe"}',
                            },
                        }
                    ]
                }
                content = ""
            elif messages and "Select only the synthetic candidate" in messages[0]["content"]:
                content = '{"track_ids":["fixture-track-1"]}'
            elif len(messages) > 1 and "candidates" in messages[1]["content"]:
                candidates = json.loads(messages[1]["content"])["candidates"]
                content = json.dumps(
                    {"title": "合成歌单", "items": [{"track_id": candidates[0]["track_id"]}]}
                )
            else:
                content = "OK"
            self.send_response(state["status"])
            if state["location"]:
                self.send_header("Location", state["location"])
            self.end_headers()
            message = {"content": content}
            if data.get("tools") and data.get("tool_choice") != "none":
                message["tool_calls"] = response["tool_calls"]
            self.wfile.write(json.dumps({"choices": [{"message": message}]}).encode())

        def do_GET(self):
            calls.append((self.path, dict(self.headers), None))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"id":"public-fixture"}')

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", calls, state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_probe_selection_provider_and_telegram_share_real_proxy(
    settings, authenticated_client, monkeypatch
):
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    monkeypatch.delenv("no_proxy", raising=False)
    music(settings, "合成.flac", ["合成艺人"], [], album="合成专辑")
    scan_library(settings)
    with proxy_server() as (address, calls, state), authenticated_client(settings) as client:
        providers = client.app.state.providers
        providers.stop()
        providers.exit.clear()
        proxy = address.replace("http://", "http://proxy-user:proxy-fixture-secret@")
        assert enable(client, proxy_mode="custom", proxy_url=proxy).status_code == 200
        created = client.post(
            "/api/v1/agent/connections",
            headers=HEADERS,
            json={
                "name": "代理测试模型",
                "base_url": "http://model.fixture.invalid/v1",
                "model": "fixture",
                "api_key": "model-fixture-secret",
            },
        )
        assert created.status_code == 200, created.text
        identity = created.json()["id"]
        probe = client.post(f"/api/v1/agent/connections/{identity}/test", headers=HEADERS)
        assert probe.status_code == 200, probe.text
        result = client.post(
            "/api/v1/ai/discover",
            headers=HEADERS,
            json={"prompt": "找一首歌", "connection_id": identity},
        )
        assert result.status_code == 200 and result.json()["mode"] == "ai"
        assert providers.request("http://source.fixture.invalid/entity")["id"] == "public-fixture"
        assert json_request(
            "http://telegram.fixture.invalid/botprivate/sendMessage",
            payload={"text": "synthetic"},
            proxy_mode="custom",
            proxy_url=proxy,
            service="telegram",
        )["choices"]
        assert len(calls) == 7
        assert all(
            calls[index][0] == "http://model.fixture.invalid/v1/chat/completions"
            and calls[index][1]["Authorization"] == "Bearer model-fixture-secret"
            for index in (0, 1, 2, 3, 4)
        )
        assert all("Proxy-Authorization" in headers for _, headers, _ in calls)
        assert probe.json()["structured"] and probe.json()["tools"]
        state.update(status=302, location="http://other.fixture.invalid/credentials")
        failed = client.post(f"/api/v1/agent/connections/{identity}/test", headers=HEADERS)
        assert failed.status_code == 200 and failed.json()["error_code"]
        assert len(calls) == 8
        assert "secret" not in failed.text
        client.app.state.diagnostics.flush()
        trace = client.app.state.diagnostics.events(trace_id=probe.headers["X-Wildstring-Trace-Id"])
        assert any(
            item["event"] == "outbound.completed" and item["via_proxy"] for item in trace["items"]
        )
        assert "secret" not in json.dumps(trace)


def test_environment_proxy_no_proxy_and_size_limits(monkeypatch):
    with proxy_server() as (address, calls, _):
        monkeypatch.setenv("http_proxy", address)
        monkeypatch.setenv("NO_PROXY", "127.0.0.1")
        monkeypatch.delenv("no_proxy", raising=False)
        assert json_request("http://public.fixture.invalid/entity")["id"] == "public-fixture"
        # Local endpoint bypasses the configured proxy; the HTTP server receives
        # the origin path rather than the absolute proxy target.
        assert json_request(address + "/local")["id"] == "public-fixture"
        assert calls[0][0] == "http://public.fixture.invalid/entity" and calls[1][0] == "/local"
        try:
            json_request(address + "/oversized", limit=4, proxy_mode="direct")
        except OutboundError as error:
            assert error.code == "response_too_large"
        else:
            raise AssertionError("response size limit not enforced")
