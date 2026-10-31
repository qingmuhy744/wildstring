"""Environment-backed application settings."""

from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, field_validator, model_validator
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
    library_dir: Path | None = None
    podcasts_dir: Path | None = None
    web_dir: Path | None = None
    admin_password: SecretStr | None = None
    cookie_secure: bool = False
    # Opt-in for hosts whose DNS runs Clash/mihomo fake-ip mode (198.18.0.0/15 answers).
    podcast_allow_fake_ip: bool = False

    @field_validator("data_dir", "music_dir", "podcasts_dir", "web_dir")
    @classmethod
    def resolve_directory(cls, value: Path | None) -> Path | None:
        if value is None:
            return None
        return value.expanduser().resolve()

    @model_validator(mode="after")
    def keep_runtime_outside_music(self):
        if self.data_dir.is_relative_to(self.music_dir):
            raise ValueError("Runtime data directory must be outside the read-only music directory")
        self.library_dir = (self.library_dir or self.data_dir / "library").expanduser().resolve()
        self.podcasts_dir = (self.podcasts_dir or self.data_dir / "podcasts").expanduser().resolve()
        if self.library_dir.is_relative_to(self.music_dir) or self.music_dir.is_relative_to(
            self.library_dir
        ):
            raise ValueError("Managed library and import source must be separate directories")
        if self.web_dir is None and self.environment != "test":
            candidate = Path("frontend/web/dist").resolve()
            if candidate.is_dir() and (candidate / "index.html").is_file():
                self.web_dir = candidate
        return self
