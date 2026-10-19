"""Bounded public contracts. No client-supplied owner, approval boolean or arbitrary tool."""

from typing import Literal
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

SCOPES = (
    "library:read",
    "personal:read",
    "drafts:write",
    "drafts:apply",
    "tasks:write",
    "diagnostics:read",
    "notifications:read",
    "library:manage",
    "personal:write",
    "web:search",
)


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, strict=True)


class CredentialCreate(Input):
    name: str = Field(min_length=1, max_length=100)
    scopes: list[str] = Field(min_length=1, max_length=len(SCOPES))
    expires_in_days: int = Field(default=30, ge=1, le=365)

    @field_validator("scopes")
    @classmethod
    def known_scopes(cls, value):
        if set(value) - set(SCOPES):
            raise ValueError("invalid_scope")
        return list(dict.fromkeys(value))


class Evidence(Input):
    source: str = Field(min_length=1, max_length=100)
    summary: str = Field(min_length=1, max_length=1000)
    url: str | None = Field(default=None, max_length=2048)

    @field_validator("url")
    @classmethod
    def safe_url(cls, value):
        if value is not None:
            parts = urlsplit(value)
            if (
                parts.scheme != "https"
                or not parts.hostname
                or parts.username
                or parts.password
                or any(ord(c) < 32 for c in value)
            ):
                raise ValueError("invalid_evidence_url")
        return value


class DraftCreate(Input):
    kind: Literal["playlist", "metadata", "intake", "lyrics"]
    title: str = Field(min_length=1, max_length=200)
    payload: dict
    evidence: list[Evidence] = Field(default_factory=list, max_length=20)


class DraftPatch(Input):
    version: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    payload: dict | None = None
    evidence: list[Evidence] | None = Field(default=None, max_length=20)


class Version(Input):
    version: int = Field(ge=1)


class Apply(Version):
    idempotency_key: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9_.:-]+$")


class PlaylistPayload(Input):
    name: str = Field(min_length=1, max_length=100)
    track_ids: list[str] = Field(max_length=5000)
    playlist_id: str | None = Field(default=None, max_length=128)
    playlist_version: int | None = Field(default=None, ge=1)


class Inspection(Input):
    track_ids: list[str] | None = Field(default=None, max_length=5000)
    max_tracks: int = Field(default=500, ge=1, le=5000)
    max_calls: int = Field(default=0, ge=0, le=100)
    connection_id: str | None = Field(default=None, max_length=128)
    use_ai: bool = False


class Schedule(Input):
    name: str = Field(min_length=1, max_length=100)
    enabled: bool = False
    interval_hours: int = Field(default=24, ge=1, le=720)
    timezone: str = "Asia/Shanghai"
    parameters: Inspection = Field(default_factory=Inspection)
    version: int | None = Field(default=None, ge=1)

    @field_validator("timezone")
    @classmethod
    def valid_zone(cls, value):
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("invalid_timezone") from None
        return value


class NotificationPreferences(Input):
    telegram_enabled: bool = False
    event_types: list[str] = Field(default_factory=list, max_length=30)
    min_severity: Literal["info", "warning", "error"] = "info"
    quiet_start: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    quiet_end: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    timezone: str = "Asia/Shanghai"

    @field_validator("timezone")
    @classmethod
    def valid_zone(cls, value):
        return Schedule.valid_zone(value)


class NotificationRead(Input):
    ids: list[str] = Field(max_length=500)


class ReadAll(Input):
    high_watermark: int = Field(ge=0)


class TelegramCreate(Input):
    name: str = Field(min_length=1, max_length=100)
    bot_token: SecretStr
    chat_id: str = Field(min_length=1, max_length=100, pattern=r"^-?\d+$")
    topic_id: int | None = Field(default=None, ge=1)
    proxy_mode: Literal["inherit", "direct"] = "inherit"
    enabled: bool = False

    @field_validator("bot_token")
    @classmethod
    def token_shape(cls, value):
        raw = value.get_secret_value()
        import re

        if not re.fullmatch(r"\d{3,20}:[A-Za-z0-9_-]{20,100}", raw):
            raise ValueError("invalid_bot_token")
        return value


class TargetState(Version):
    enabled: bool


class Verify(Input):
    code: str = Field(pattern=r"^\d{6}$")


class Retry(Input):
    acknowledge_unknown: bool = False


class EndpointPolicy(Input):
    allowed_hosts: list[str] = Field(default_factory=list, max_length=100)
    allow_private: bool = False

    @field_validator("allowed_hosts")
    @classmethod
    def hosts(cls, value):
        import re

        if any(not re.fullmatch(r"[A-Za-z0-9.:[\]-]{1,253}", host) for host in value):
            raise ValueError("invalid_endpoint_host")
        return [host.lower().strip("[]") for host in value]


class Connection(Input):
    name: str = Field(min_length=1, max_length=100)
    scope: Literal["personal", "instance"] = "personal"
    base_url: str = Field(min_length=1, max_length=2048)
    model: str = Field(min_length=1, max_length=200)
    api_key: SecretStr | None = None
    clear_api_key: bool = False
    timeout: int = Field(default=90, ge=1, le=120)
    shared: bool = False
    background_allowed: bool = False
    daily_call_budget: int = Field(default=100, ge=0, le=10000)
    enabled: bool = True
    version: int | None = Field(default=None, ge=1)
    protocol: Literal["chat_completions", "responses"] = "chat_completions"
    provider: Literal["generic", "openai", "deepseek", "qwen", "gemini"] = "generic"
    reasoning_effort: Literal["auto", "none", "low", "medium", "high", "max", "xhigh"] = "low"
    max_output_tokens: int = Field(default=8192, ge=128, le=32768)
    native_search: bool = False
    stream_output: bool = True

    @field_validator("base_url")
    @classmethod
    def safe_endpoint(cls, value):
        parts = urlsplit(value)
        if (
            parts.scheme not in {"http", "https"}
            or not parts.hostname
            or parts.username
            or parts.password
            or parts.query
            or parts.fragment
            or any(c.isspace() or ord(c) < 32 for c in value)
        ):
            raise ValueError("invalid_ai_endpoint")
        _ = parts.port
        return value.rstrip("/")

    @field_validator("api_key")
    @classmethod
    def safe_key(cls, value):
        if value is not None and (
            len(value.get_secret_value()) > 4096
            or any(ord(c) < 32 or ord(c) > 126 for c in value.get_secret_value())
        ):
            raise ValueError("invalid_api_key")
        return value


class ConversationCreate(Input):
    title: str = Field(default="新对话", min_length=1, max_length=200)
    connection_id: str | None = Field(default=None, max_length=128)


class ConversationRename(Input):
    title: str = Field(min_length=1, max_length=200)


class MessageCreate(Input):
    content: str = Field(min_length=1, max_length=8000)
    connection_id: str | None = Field(default=None, max_length=128)
    max_calls: int = Field(default=4, ge=1, le=8)


class AssistantPreferences(Input):
    retention_days: int = Field(default=30, ge=1, le=365)
    context_summary: bool = True
    long_term_memory: bool = True


class SearchSettings(Input):
    provider: Literal["deepseek", "tavily"] = "deepseek"
    enabled: bool = False
    daily_budget: int = Field(default=100, ge=0, le=10000)
    api_key: SecretStr | None = None
    clear_api_key: bool = False
    version: int = Field(default=0, ge=0)

    _safe_key = field_validator("api_key")(Connection.safe_key.__func__)


class Memory(Input):
    content: str = Field(min_length=1, max_length=1000)
    version: int | None = Field(default=None, ge=1)
