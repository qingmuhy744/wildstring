"""Environment-backed application settings."""

from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="WILDSTRING_", env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    environment: Literal["development", "test", "production"] = "development"
    host: str = "127.0.0.1"
    port: int = Field(default=18780, ge=1, le=65535)
    data_dir: Path = Path("runtime")
    music_dir: Path = Path("music")
    web_dir: Path | None = None

    @field_validator("data_dir", "music_dir")
    @classmethod
    def resolve_directory(cls, value: Path) -> Path:
        return value.expanduser().resolve()

    @model_validator(mode="after")
    def keep_runtime_outside_music(self):
        if self.data_dir.is_relative_to(self.music_dir):
            raise ValueError("Runtime data directory must be outside the read-only music directory")
        return self
