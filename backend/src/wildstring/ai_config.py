"""Private AI connection settings; model access never grants library write access."""

import http.client
import json
import os
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import HTTPException
from filelock import FileLock
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator


class AIUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    version: int = Field(ge=1, strict=True)
    base_url: str = Field(min_length=1, max_length=2048)
    model: str = Field(min_length=1, max_length=200)
    timeout: int = Field(default=30, ge=1, le=120, strict=True)
    api_key: SecretStr | None = None
    clear_api_key: bool = Field(default=False, strict=True)

    @field_validator("base_url")
    @classmethod
    def validate_url(cls, value):
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
            raise ValueError("Invalid model API base URL")
        _ = parts.port
        return value.rstrip("/")

    @field_validator("api_key")
    @classmethod
    def validate_key(cls, value):
        if value is not None:
            raw = value.get_secret_value()
            if len(raw) > 4096 or any(ord(c) < 32 or ord(c) > 126 for c in raw):
                raise ValueError("Invalid API key")
        return value


class AIService:
    def __init__(self, data_dir: Path):
        self.directory = data_dir / "ai"
        self.path = self.directory / ".env"
        self.lock = FileLock(data_dir / "ai-settings.lock", timeout=5)

    def read(self):
        if not self.path.exists():
            return {"version": 1, "base_url": "", "model": "", "timeout": 30, "api_key": ""}
        try:
            values = {}
            for line in self.path.read_text().splitlines():
                if line:
                    key, value = line.split("=", 1)
                    values[key.removeprefix("WILDSTRING_AI_").lower()] = json.loads(value)
            AIUpdate.model_validate(
                {key: values[key] for key in ["version", "base_url", "model", "timeout", "api_key"]}
            )
            return values
        except (OSError, ValueError, KeyError):
            raise HTTPException(503, "ai_settings_unavailable") from None

    @staticmethod
    def public(config):
        return {key: config[key] for key in ["version", "base_url", "model", "timeout"]} | {
            "has_api_key": bool(config["api_key"]),
            "configured": bool(config["base_url"] and config["model"]),
        }

    def get(self):
        return self.public(self.read())

    def save(self, body):
        with self.lock:
            current = self.read()
            if body.version != current["version"]:
                raise HTTPException(409, "ai_settings_version_conflict")
            key = (
                ""
                if body.clear_api_key
                else body.api_key.get_secret_value()
                if body.api_key is not None
                else current["api_key"]
            )
            config = {
                "version": current["version"] + 1,
                "base_url": body.base_url,
                "model": body.model,
                "timeout": body.timeout,
                "api_key": key,
            }
            self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            descriptor, temporary = tempfile.mkstemp(prefix=".settings-", dir=self.directory)
            try:
                with os.fdopen(descriptor, "w") as output:
                    for name, value in config.items():
                        output.write(
                            f"WILDSTRING_AI_{name.upper()}={json.dumps(value, ensure_ascii=False)}\n"
                        )
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, self.path)
            finally:
                Path(temporary).unlink(missing_ok=True)
            return self.public(config)

    def probe(self):
        config = self.read()
        if not config["base_url"] or not config["model"]:
            raise HTTPException(409, "ai_not_configured")
        parts = urlsplit(config["base_url"])
        connector = (
            http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
        )
        connection = connector(parts.hostname, parts.port, timeout=config["timeout"])
        try:
            headers = {"Content-Type": "application/json"}
            if config["api_key"]:
                headers["Authorization"] = f"Bearer {config['api_key']}"
            body = json.dumps(
                {
                    "model": config["model"],
                    "messages": [{"role": "user", "content": "Reply OK."}],
                    "max_tokens": 16,
                    "stream": False,
                }
            )
            connection.request("POST", parts.path.rstrip("/") + "/chat/completions", body, headers)
            response = connection.getresponse()
            if not 200 <= response.status < 300:
                raise HTTPException(502, "ai_connection_failed")
            raw = response.read(65537)
            if (
                len(raw) > 65536
                or not isinstance(json.loads(raw).get("choices"), list)
                or not json.loads(raw)["choices"]
            ):
                raise HTTPException(502, "ai_invalid_response")
            return {"ok": True, "model": config["model"], "scope": "chat_completion"}
        except (OSError, http.client.HTTPException, ValueError, AttributeError):
            raise HTTPException(502, "ai_connection_failed") from None
        finally:
            connection.close()
