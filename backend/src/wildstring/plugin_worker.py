"""One isolated-lifetime JSON request for an administrator-installed Python plugin.

This is process separation, not a security sandbox. ZIP plugins are trusted code.
They cannot be imported or enabled by a model, MCP credential or ordinary account.
"""

import importlib.util
import json
import sys
import time
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request

from wildstring.outbound import OutboundError, request_bytes
from wildstring.source_plugins import PluginError


class Context:
    def __init__(self, data):
        self.data = data
        self.directory = Path(data["directory"])
        self.directory.mkdir(parents=True, exist_ok=True)
        self.deadline = time.monotonic() + 50

    def http(self, url, *, payload=None, headers=None):
        remaining = min(12, self.deadline - time.monotonic())
        if remaining <= 0:
            raise PluginError("source_plugin_timeout")
        request = Request(
            url,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={
                "Accept": "application/json",
                **({"Content-Type": "application/json"} if payload is not None else {}),
                **(headers or {}),
            },
        )
        _, _, raw = request_bytes(
            request,
            timeout=remaining,
            limit=2 * 1024 * 1024,
            proxy_mode=self.data["proxy_mode"],
            proxy_url=self.data.get("proxy_url"),
            service="source_plugin",
        )
        result = json.loads(raw)
        if (
            not isinstance(result, dict)
            or result.get("code") not in (None, 0, 200)
            or result.get("error_code") not in (None, 0)
        ):
            raise PluginError("source_plugin_auth_or_rejected")
        return result

    def bridge(self, path, parameters):
        cookie = self.data["secrets"].get("cookie")
        return self.http(
            self.data["config"]["base_url"].rstrip("/") + path + "?" + urlencode(parameters),
            headers={"Cookie": cookie} if cookie else None,
        )


def main():
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024, 8 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (45, 45))
    except ImportError:
        pass
    result = {"error": "source_plugin_worker_failed"}
    try:
        data = json.loads(sys.stdin.buffer.read(2 * 1024 * 1024 + 1))
        root = Path(data["path"])
        sys.path[:0] = [str(root / "lib"), str(root)]
        module_name, class_name = data["entrypoint"].split(":")
        spec = importlib.util.spec_from_file_location(module_name, root / (module_name + ".py"))
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        # Adapter print output is discarded; stdout is exclusively the bounded JSON protocol.
        from contextlib import redirect_stdout

        with redirect_stdout(sys.stderr):
            spec.loader.exec_module(module)
            plugin = getattr(module, class_name)()
            method = data["method"]
            if method not in {"search", "metadata", "lyrics"}:
                raise ValueError
            value = getattr(plugin, method)(Context(data), data["value"])
        result = {"value": value}
        if len(json.dumps(result).encode()) > 2 * 1024 * 1024:
            result = {"error": "source_plugin_response_too_large"}
    except Exception as error:
        result = {
            "error": error.code
            if isinstance(error, PluginError | OutboundError)
            else "source_plugin_worker_failed"
        }
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
