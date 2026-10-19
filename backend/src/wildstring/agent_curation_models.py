"""Pure input contracts; do not import tool execution from schema generation."""

from pydantic import Field

from wildstring.agent_models import Input
from wildstring.library.edits import Overrides


class MetadataItem(Input):
    track_id: str = Field(min_length=1, max_length=128)
    metadata_version: int = Field(ge=1)
    overrides: Overrides


class MetadataBatch(Input):
    items: list[MetadataItem] = Field(min_length=1, max_length=500)
    album_ids: list[str] = Field(default_factory=list, max_length=20)
