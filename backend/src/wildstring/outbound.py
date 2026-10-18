"""One bounded transport for probes, providers, AI and notifications.

Exceptions never become log messages: URLs may carry credentials. Callers may
inject an opener for a fixture, but production always uses the same policies.
"""

import http.client
import json
import socket
import ssl
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import (
    HTTPRedirectHandler,
    ProxyHandler,
    Request,
    build_opener,
    getproxies_environment,
    proxy_bypass,
)


class OutboundError(Exception):
    def __init__(self, code, http_status=None, retry_after=None):
        self.code, self.http_status, self.retry_after = code, http_status, retry_after
        super().__init__(code)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def validate_proxy(value):
    try:
        parsed = urlsplit(value)
        if (
            parsed.scheme != "http"
            or not parsed.hostname
            or parsed.port is None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or any(c.isspace() for c in value)
        ):
            raise ValueError
    except ValueError:
        raise ValueError("invalid_proxy_url") from None
    return value


def outbound_proxies(mode, proxy=None):
    if mode == "custom":
        if not proxy:
            raise ValueError("proxy_not_configured")
        return {"http": validate_proxy(proxy), "https": validate_proxy(proxy)}
    if mode == "environment":
        env = getproxies_environment()
        proxies = {
            protocol: value
            for protocol in ("http", "https")
            if (value := env.get(protocol) or env.get("all"))
        }
        try:
            valid = all(urlsplit(value).scheme == "http" for value in proxies.values())
        except ValueError:
            valid = False
        if not valid:
            raise ValueError("proxy_protocol_unsupported")
        return proxies
    if mode != "direct":
        raise ValueError("invalid_proxy_mode")
    return {}


def network_error(error):
    reason = error.reason if isinstance(error, URLError) else error
    if isinstance(reason, ssl.SSLEOFError):
        return "tls_eof"
    if isinstance(reason, ssl.SSLError):
        return "tls_error"
    if isinstance(reason, TimeoutError):
        return "timeout"
    if isinstance(reason, socket.gaierror):
        return "dns_error"
    if isinstance(reason, ConnectionRefusedError):
        return "connection_refused"
    if isinstance(reason, ConnectionResetError):
        return "connection_reset"
    if isinstance(reason, str) and reason.startswith("Tunnel connection failed: 407"):
        return "proxy_auth_required"
    return "network_unavailable"


def request_bytes(
    request,
    *,
    proxy_mode="environment",
    proxy_url=None,
    timeout=30,
    limit=2 * 1024 * 1024,
    redirect=None,
    opener_factory=None,
    service="external",
    consume=None,
):
    """Return (status, headers, bytes); HTTPError stays available to API parsers.

    Proxy bypass is shared for explicit and environment proxies, matching urllib.
    A redirect policy must be explicitly supplied for public image hosts; model
    and Telegram credentials are never forwarded to another endpoint.
    """
    parts = urlsplit(request.full_url)
    if parts.scheme not in {"http", "https"} or not parts.hostname:
        raise OutboundError("invalid_endpoint")
    started = time.monotonic()
    status, code = None, "ok"
    proxies = outbound_proxies(proxy_mode, proxy_url)
    via_proxy = bool(proxies.get(parts.scheme)) and not proxy_bypass(parts.hostname)
    try:
        opener = (opener_factory or build_opener)(ProxyHandler(proxies), redirect or NoRedirect())
        with opener.open(request, timeout=timeout) as response:  # nosec B310 -- validated schemes and explicit redirect policies
            status = response.status
            raw = consume(response, limit) if consume is not None else response.read(limit + 1)
            if consume is None and len(raw) > limit:
                raise OutboundError("response_too_large", status)
            return status, getattr(response, "headers", {}), raw
    except HTTPError as error:
        status = error.code
        code = "proxy_auth_required" if status == 407 else "http_error"
        raise
    except OutboundError as error:
        code = error.code
        raise
    except (URLError, OSError, http.client.HTTPException) as error:
        code = network_error(error)
        raise OutboundError(code) from None
    finally:
        from wildstring.diagnostics import record_event

        record_event(
            "outbound.completed",
            level="INFO" if code == "ok" else "WARNING",
            service=service,
            domain=parts.hostname,
            proxy_mode=proxy_mode,
            via_proxy=via_proxy,
            http_status=status,
            elapsed_ms=round((time.monotonic() - started) * 1000),
            code=code,
        )


def json_request(
    url,
    *,
    payload=None,
    headers=None,
    timeout=30,
    proxy_mode="environment",
    proxy_url=None,
    service="external",
    method=None,
    limit=2 * 1024 * 1024,
    error_payload=False,
):
    request = Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None,
        headers={"Accept": "application/json", "Content-Type": "application/json"}
        | (headers or {}),
        method=method,
    )
    try:
        status, _, raw = request_bytes(
            request,
            proxy_mode=proxy_mode,
            proxy_url=proxy_url,
            timeout=timeout,
            limit=limit,
            service=service,
        )
        if not 200 <= status < 300:
            raise OutboundError("http_error", status)
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError
        return result
    except HTTPError as error:
        if error_payload:
            try:
                raw = error.read(limit + 1)
                result = json.loads(raw) if len(raw) <= limit else None
                if isinstance(result, dict) and result.get("error_code") == error.code:
                    return result
            except (OSError, ValueError, UnicodeError, RecursionError):
                pass
            finally:
                error.close()
        retry = error.headers.get("Retry-After") if error.headers else None
        retry = min(int(retry), 86400) if retry and retry.isdecimal() else None
        error.close()
        raise OutboundError(
            "rate_limited"
            if error.code == 429
            else "credentials_rejected"
            if error.code in {401, 403}
            else "http_error",
            error.code,
            retry,
        ) from None
    except (ValueError, UnicodeError, RecursionError):
        raise OutboundError("invalid_response") from None
