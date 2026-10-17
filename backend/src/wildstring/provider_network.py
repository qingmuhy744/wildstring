"""Non-mutating dependency checks through the actual source clients."""

import time
from concurrent.futures import ThreadPoolExecutor
from typing import Literal
from urllib.parse import urlsplit
from urllib.request import proxy_bypass

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from wildstring.outbound import (
    network_error as network_error,
)
from wildstring.outbound import (
    outbound_proxies as outbound_proxies,
)
from wildstring.outbound import (
    validate_proxy as validate_proxy,
)

# MusicBrainz's CAA API documentation uses this public release. No private
# titles, fingerprints or original audio are sent by a connectivity check.
CAA_SAMPLE = "76df3287-6cda-33eb-8e9a-044b5e15ffdd"


class NetworkTest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    proxy_mode: Literal["environment", "custom", "direct"]
    proxy_url: str | None = Field(default=None, max_length=2048, repr=False)


def _probe(provider, mode, proxy, credentials, client):
    from wildstring.providers import ACOUSTID, FM, MB, ProviderError

    started = time.monotonic()
    domain = {
        "musicbrainz": "musicbrainz.org",
        "lastfm": "ws.audioscrobbler.com",
        "caa": "coverartarchive.org",
        "acoustid": "api.acoustid.org",
    }[provider]
    proxies = outbound_proxies(mode, proxy)
    result = {
        "provider": provider,
        "status": "error",
        "code": "network_unavailable",
        "elapsed_ms": 0,
        "domain": domain,
        "scope": "functional_api",
        "via_proxy": bool(proxies.get("https")) and not proxy_bypass(domain),
        "checks": [],
    }
    missing = (provider == "lastfm" and not credentials.get("api_key")) or (
        provider == "acoustid" and not credentials.get("acoustid_api_key")
    )
    if missing:
        return result | {"status": "unconfigured", "code": provider + "_not_configured"}
    network = {"proxy_mode": mode, "proxy_url": proxy, "diagnostic": True}
    stage = "api"
    try:
        if provider == "musicbrainz":
            payload = client.request(
                MB + "artist/bfcc6d75-a6a5-4bc6-8282-47aec8531818", {"fmt": "json"}, **network
            )
            valid = payload.get("id") == "bfcc6d75-a6a5-4bc6-8282-47aec8531818"
        elif provider == "lastfm":
            payload = client.request(FM, {"method": "artist.getInfo", "artist": "Cher"}, **network)
            valid = isinstance(payload.get("artist"), dict)
        elif provider == "acoustid":
            payload = client.request(
                ACOUSTID, {"trackid": "9ff43b6a-4f16-427c-93c2-92307ca505e0"}, **network
            )
            valid = payload.get("status") == "ok" and isinstance(payload.get("results"), list)
        else:
            payload = client.request("https://coverartarchive.org/release/" + CAA_SAMPLE, **network)
            valid = isinstance(payload.get("images"), list) and bool(payload["images"])
        if not valid:
            raise ProviderError("provider_invalid_response", False)
        result["checks"].append(
            {
                "name": stage,
                "status": "ok",
                "code": "valid_response",
                "scope": "functional_api",
                "http_status": 200,
                "domain": domain,
            }
        )
        if provider == "caa":
            stage = "image_download_decode"
            images = sorted(payload["images"], key=lambda item: not item.get("front"))
            # cover_data validates the public URL, redirects, byte/pixel limits and
            # decodes via the same Pillow path as preview/apply.
            image = images[0]
            address = image.get("thumbnails", {}).get("250") or image.get("image")
            if not isinstance(address, str):
                raise ProviderError("provider_invalid_response", False)
            client.cover_data(address, **network)
            result["checks"].append(
                {
                    "name": stage,
                    "status": "ok",
                    "code": "image_decoded",
                    "scope": "cover_download",
                    "domain": urlsplit(address).hostname,
                }
            )
        result.update(status="ok", code="reachable", http_status=200)
        if provider == "lastfm":
            result["checks"].append(
                {
                    "name": "personal_authorization",
                    "status": "unverified",
                    "code": "separate_user_authorization",
                    "scope": "personal_account",
                    "domain": domain,
                }
            )
        if provider == "acoustid":
            result["checks"].append(
                {
                    "name": "local_fingerprint",
                    "status": "unverified",
                    "code": "separate_local_capability",
                    "scope": "audio_recognition",
                    "domain": domain,
                }
            )
    except (ProviderError, HTTPException) as error:
        code = error.code if isinstance(error, ProviderError) else error.detail
        status = getattr(error, "http_status", None)
        result.update(code=code)
        if status:
            result["http_status"] = status
        result["checks"].append(
            {
                "name": stage,
                "status": "error",
                "code": code,
                "scope": "functional_api" if stage == "api" else "cover_download",
                "domain": domain,
                **({"http_status": status} if status else {}),
            }
        )
    except (ValueError, TypeError, KeyError, AttributeError):
        result["code"] = "provider_invalid_response"
    result["elapsed_ms"] = round((time.monotonic() - started) * 1000)
    return result


def test_network(mode, proxy, credentials, client):
    outbound_proxies(mode, proxy)
    # ContextVars must be copied separately into each worker (copying one Context
    # concurrently is illegal). This keeps all dependency checks in one trace.
    from contextvars import copy_context

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [
            pool.submit(copy_context().run, _probe, name, mode, proxy, credentials, client)
            for name in ("musicbrainz", "lastfm", "caa", "acoustid")
        ]
        return {"proxy_mode": mode, "items": [future.result() for future in futures]}
