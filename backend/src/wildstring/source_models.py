"""Validated contracts shared by plugin routes and background lyric scans."""

from pydantic import BaseModel, ConfigDict, Field


class LyricChoice(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: int = Field(ge=1)
    file_version: str = Field(pattern=r"^[0-9a-f]{64}$")
    offset_ms: int = Field(default=0, ge=-60_000, le=60_000)
