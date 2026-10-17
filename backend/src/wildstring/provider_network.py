"""Fixed, non-mutating service probes and shared outbound proxy/error handling."""

import json
import socket
import ssl
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Literal
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import (
    HTTPRedirectHandler,
    ProxyHandler,
    Request,
    build_opener,
    getproxies_environment,
    proxy_bypass,
)

from pydantic import BaseModel, ConfigDict, Field

UA = "WildString/0.3.3 (https://github.com/qingmuhy744/wildstring)"
MAX_RESPONSE = 256 * 1024


class NetworkTest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    proxy_mode: Literal["environment", "custom", "direct"]
    proxy_url: str | None = Field(default=None, max_length=2048, repr=False)


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
    return {}


def network_error(error):
    """Only stable codes leave this boundary; exceptions can contain signed URLs."""
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
    # urllib can wrap proxy CONNECT failures in a string instead of an HTTPError.
    if isinstance(reason, str) and reason.startswith("Tunnel connection failed: 407"):
        return "proxy_auth_required"
    return "network_unavailable"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def _api_error(provider, payload):
    if provider == "lastfm" and "error" in payload:
        return f"lastfm_error_{int(payload['error'])}"
    if provider == "acoustid" and payload.get("status") != "ok":
        return f"acoustid_error_{int(payload.get('error', {}).get('code', 0))}"
    return None


def _probe(provider, url, proxies, missing=None):
    started = time.monotonic()
    result = {
        "provider": provider,
        "status": "error",
        "code": "network_unavailable",
        "elapsed_ms": 0,
        "via_proxy": bool(proxies.get("https")) and not proxy_bypass(urlsplit(url).hostname),
    }
    if missing:
        return result | {"status": "unconfigured", "code": missing}
    try:
        req = Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        # Targets are fixed below; never follow an arbitrary redirect or take a client URL.
        with build_opener(ProxyHandler(proxies), NoRedirect()).open(req, timeout=8) as response:  # nosec B310
            result["http_status"] = response.status
            raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            result["code"] = "provider_response_too_large"
        else:
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                result["code"] = "provider_invalid_response"
            elif code := _api_error(provider, payload):
                result["code"] = code
            elif (
                (provider == "musicbrainz" and not payload.get("id"))
                or (provider == "lastfm" and not isinstance(payload.get("artist"), dict))
                or (provider == "acoustid" and not isinstance(payload.get("results"), list))
            ):
                result["code"] = "provider_invalid_response"
            else:
                result.update(status="ok", code="reachable")
    except HTTPError as error:
        result["http_status"] = error.code
        # A missing, fixed release is deliberate: no cover downloads or private library data.
        if provider == "caa" and error.code == 404:
            result.update(status="ok", code="reachable")
        else:
            result["code"] = "proxy_auth_required" if error.code == 407 else "provider_http_error"
            if provider in {"lastfm", "acoustid"}:
                try:
                    payload = json.loads(error.read(MAX_RESPONSE + 1))
                    result["code"] = _api_error(provider, payload) or result["code"]
                except (ValueError, TypeError, AttributeError):
                    pass
                except (URLError, TimeoutError, OSError) as failure:
                    result["code"] = network_error(failure)
        error.close()
    except (URLError, TimeoutError, OSError) as error:
        result["code"] = network_error(error)
    except (ValueError, TypeError, AttributeError):
        result["code"] = "provider_invalid_response"
    result["elapsed_ms"] = round((time.monotonic() - started) * 1000)
    return result


def test_network(mode, proxy, credentials):
    proxies = outbound_proxies(mode, proxy)
    checks = [
        (
            "musicbrainz",
            "https://musicbrainz.org/ws/2/artist/bfcc6d75-a6a5-4bc6-8282-47aec8531818?fmt=json",
            None,
        ),
        (
            "lastfm",
            "https://ws.audioscrobbler.com/2.0/?"
            + urlencode(
                {
                    "method": "artist.getInfo",
                    "artist": "Cher",
                    "format": "json",
                    "api_key": credentials.get("api_key", ""),
                }
            ),
            None if credentials.get("api_key") else "lastfm_not_configured",
        ),
        ("caa", "https://coverartarchive.org/release/00000000-0000-0000-0000-000000000000", None),
        (
            "acoustid",
            "https://api.acoustid.org/v2/lookup?"
            + urlencode(
                {
                    "trackid": "9ff43b6a-4f16-427c-93c2-92307ca505e0",
                    "format": "json",
                    "client": credentials.get("acoustid_api_key", ""),
                }
            ),
            None if credentials.get("acoustid_api_key") else "acoustid_not_configured",
        ),
    ]
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [
            pool.submit(_probe, name, url, proxies, missing) for name, url, missing in checks
        ]
        return {"proxy_mode": mode, "items": [future.result() for future in futures]}
