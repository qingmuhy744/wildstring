"""Run local AI hand-testing or a disposable model connection probe."""

import argparse
import os
import secrets
import shutil
import sys
from getpass import getpass
from pathlib import Path
from tempfile import TemporaryDirectory

import uvicorn
from pydantic import SecretStr, ValidationError

from wildstring.agent_common import Actor
from wildstring.agent_models import Connection
from wildstring.agent_platform import AgentPlatform
from wildstring.config import Settings
from wildstring.library.scanner import scan_library
from wildstring.main import create_app
from wildstring.outbound import validate_proxy
from wildstring.providers import Providers

ROOT = Path(__file__).resolve().parents[1]
LOCAL_STATE = ROOT / "runtime" / "ai-test"
CONNECTION_NAME = "Local test AI"
DEFAULT_PORT = 18783
TRUTHY = {"1", "true", "yes", "on"}
SYNC_FIELDS = ("base_url", "model", "protocol", "provider", "reasoning_effort", "native_search")


def file_connection(*, required: bool) -> Connection | None:
    base_url = os.getenv("WILDSTRING_TEST_AI_BASE_URL", "").strip()
    model = os.getenv("WILDSTRING_TEST_AI_MODEL", "").strip()
    key = os.getenv("WILDSTRING_TEST_AI_API_KEY", "")
    protocol = os.getenv("WILDSTRING_TEST_AI_PROTOCOL", "").strip()
    provider = os.getenv("WILDSTRING_TEST_AI_PROVIDER", "").strip()
    effort = os.getenv("WILDSTRING_TEST_AI_REASONING_EFFORT", "").strip()
    native_search_raw = os.getenv("WILDSTRING_TEST_AI_NATIVE_SEARCH", "").strip().lower()
    if not (
        required or base_url or model or key or protocol or provider or effort or native_search_raw
    ):
        return None
    if not base_url or not model:
        raise SystemExit("Set WILDSTRING_TEST_AI_BASE_URL and WILDSTRING_TEST_AI_MODEL.")
    resolved_protocol = protocol or "chat_completions"
    resolved_provider = provider or ("gemini" if resolved_protocol == "gemini" else "generic")
    try:
        return Connection.model_validate(
            {
                "name": CONNECTION_NAME,
                "base_url": base_url,
                "model": model,
                "api_key": SecretStr(key) if key else None,
                "protocol": resolved_protocol,
                "provider": resolved_provider,
                "reasoning_effort": effort or "auto",
                "native_search": native_search_raw in TRUTHY,
            }
        )
    except ValidationError:
        raise SystemExit(
            "Invalid local AI test configuration. Check the URL, model, key, protocol, provider "
            "and reasoning effort."
        ) from None


def file_proxy() -> tuple[str, str | None] | None:
    raw = os.getenv("WILDSTRING_TEST_AI_PROXY", "").strip()
    if not raw:
        return None
    if raw.lower() == "direct":
        return ("direct", None)
    try:
        return ("custom", validate_proxy(raw))
    except ValueError:
        raise SystemExit(
            "Invalid WILDSTRING_TEST_AI_PROXY. Use an http://host:port URL or 'direct'."
        ) from None


def sync_proxy(platform: AgentPlatform, proxy_setting: tuple[str, str | None] | None) -> None:
    if proxy_setting is None:
        return
    mode, proxy_url = proxy_setting
    if mode == "custom":
        providers = getattr(platform, "providers", None) or Providers(platform.repository)
        providers.secrets({"proxy_url": proxy_url})
    with platform.database.connect(write=True) as db:
        db.execute("UPDATE provider_settings SET proxy_mode=? WHERE id=1", (mode,))


def sync_connection(platform: AgentPlatform, actor: Actor, config: Connection) -> str:
    with platform.database.connect() as db:
        row = db.execute(
            "SELECT * FROM agent_connections WHERE user_id=? AND scope='personal' AND name=? "
            "ORDER BY created_at DESC LIMIT 1",
            (actor.user_id, config.name),
        ).fetchone()
    if row is None:
        return platform.save_connection(actor, config)["id"]

    previous = platform.connection_public(row)
    key = config.api_key.get_secret_value() if config.api_key else ""
    key_changed = key != platform.read_secret(row["secret_ref"])
    if not key_changed and all(
        previous.get(field) == getattr(config, field) for field in SYNC_FIELDS
    ):
        return row["id"]

    update = config.model_copy(
        update={
            "api_key": config.api_key if key_changed else None,
            "clear_api_key": key_changed and not key,
            "version": row["version"],
            "enabled": bool(row["enabled"]),
            "background_allowed": bool(row["background_allowed"]),
            "daily_call_budget": row["daily_call_budget"],
        }
    )
    return platform.save_connection(actor, update, row["id"])["id"]


def isolated_settings(
    root: Path, *, port: int = DEFAULT_PORT, web_dir: Path | None = None
) -> Settings:
    return Settings(
        _env_file=None,
        environment="test",
        host="127.0.0.1",
        port=port,
        data_dir=root,
        music_dir=root / "source",
        library_dir=root / "library",
        podcasts_dir=root / "podcasts",
        web_dir=web_dir,
        admin_password=None,
        cookie_secure=False,
        connection_policy="mixed",
        podcast_identity_auto_backfill=False,
    )


def serve(
    config: Connection | None,
    port: int,
    proxy_setting: tuple[str, str | None] | None = None,
) -> None:
    settings = isolated_settings(LOCAL_STATE, port=port, web_dir=ROOT / "frontend/web/dist")
    settings.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    settings.music_dir.mkdir(exist_ok=True)
    app = create_app(settings)
    platform = app.state.agent_platform
    platform.database.initialize()
    if not platform.auth.configured():
        password = os.getenv("WILDSTRING_TEST_ADMIN_PASSWORD")
        if not password:
            if not sys.stdin.isatty():
                raise SystemExit(
                    "Set WILDSTRING_TEST_ADMIN_PASSWORD for the first local test startup."
                )
            password = getpass("New local test admin password (12–128 characters): ")
            if password != getpass("Confirm local test admin password: "):
                raise SystemExit("Passwords do not match.")
        try:
            platform.auth.set_password(password, only_if_empty=True)
        except ValueError as error:
            raise SystemExit(str(error)) from None

    sample = settings.library_dir / "AI Test" / "Playback Sample.mp3"
    if not sample.exists():
        sample.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / "tests/fixtures/audio/playback.mp3", sample)
    scan_library(settings)
    sync_proxy(platform, proxy_setting)
    if config is not None:
        sync_connection(platform, platform.current_actor("admin"), config)
        print(f"Configured {CONNECTION_NAME} for the local test admin.", flush=True)
    print(f"Local AI test: http://{settings.host}:{settings.port}", flush=True)
    uvicorn.run(app, host=settings.host, port=settings.port, proxy_headers=False, access_log=False)


def probe(config: Connection, proxy_setting: tuple[str, str | None] | None = None) -> int:
    with TemporaryDirectory(prefix="wildstring-ai-test-") as directory:
        settings = isolated_settings(Path(directory))
        platform = create_app(settings).state.agent_platform
        platform.database.initialize()
        platform.auth.set_password(secrets.token_urlsafe())
        sync_proxy(platform, proxy_setting)
        mode, _ = platform.network_policy()
        print(f"proxy_mode: {mode}")
        actor = platform.current_actor("admin")
        connection = platform.save_connection(actor, config)
        result = platform.test_connection(actor, connection["id"])
        for capability in ("text", "structured", "tools", "tools_roundtrip"):
            print(f"{capability}: {'pass' if result[capability] else 'unverified'}")
        if result.get("error_code"):
            print(f"error_code: {result['error_code']}")
        return 0 if result["text"] else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("serve", "probe"))
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args()
    config = file_connection(required=args.mode == "probe")
    proxy_setting = file_proxy()
    if args.mode == "serve":
        serve(config, args.port, proxy_setting)
        return 0
    if config is None:
        raise SystemExit("Set WILDSTRING_TEST_AI_BASE_URL and WILDSTRING_TEST_AI_MODEL.")
    return probe(config, proxy_setting)


if __name__ == "__main__":
    raise SystemExit(main())
