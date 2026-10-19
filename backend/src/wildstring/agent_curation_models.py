"""Pure input contracts; do not import tool execution from schema generation."""

from pydantic import Field

from wildstring.agent_models import Input
from wildstring.library.artwork import CoverSelection
from wildstring.library.edits import Overrides


class MetadataItem(Input):
    track_id: str = Field(min_length=1, max_length=128)
    metadata_version: int = Field(ge=1)
    overrides: Overrides
    source_suggestion_id: str | None = Field(default=None, min_length=1, max_length=128)
    source_digest: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")


class MetadataBatch(Input):
    items: list[MetadataItem] = Field(min_length=1, max_length=500)
    cover_draft_id: str | None = Field(default=None, min_length=1, max_length=128)
    cover_snapshot: CoverSelection | None = None
    album_ids: list[str] = Field(default_factory=list, max_length=20)
