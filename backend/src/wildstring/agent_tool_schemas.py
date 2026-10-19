"""Self-describing tool inputs; shared constraints mirror service validation."""

from pydantic import BaseModel, ConfigDict, Field

from wildstring.agent_models import Evidence, PlaylistPayload
from wildstring.agent_music_models import IntakePayload, LyricsPayload
from wildstring.library.edits import Overrides


class MetadataPayload(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    track_id: str = Field(min_length=1, max_length=128)
    metadata_version: int = Field(ge=1)
    overrides: Overrides


def describe(name, schema):
    properties = schema["properties"]
    for key, value in properties.items():
        if value["type"] == "string":
            value["maxLength"] = 2048
        if key.endswith("_id") and key != "trace_id":
            value.update(minLength=1, maxLength=128)
        if key == "limit":
            value.update(minimum=1, maximum=100, default=50)
        elif key == "offset":
            value.update(minimum=0, maximum=1000000, default=0)
        elif key == "q":
            value.update(maxLength=256, default="")
        elif key == "version":
            value.update(minimum=1)
        elif key == "max_tracks":
            value.update(minimum=1, maximum=5000, default=500)
        elif key == "max_calls":
            value.update(minimum=0, maximum=100, default=0)
        elif key == "use_ai":
            value.update(
                default=False,
                description="Explicitly opt in; requires an authorized background connection and call budget.",
            )
        elif key == "idempotency_key":
            value.update(minLength=8, maxLength=128, pattern=r"^[A-Za-z0-9_.:-]+$")
        elif key == "track_ids":
            value.update(maxItems=100 if name == "request_metadata_refresh" else 5000)
            value["items"].update(minLength=1, maxLength=128)
    if name == "get_personal_library":
        properties["kind"]["enum"] = ["playlists", "favorites", "history"]
    if name == "create_draft":
        definitions = {}

        def model_schema(model):
            value = model.model_json_schema()
            definitions.update(value.pop("$defs", {}))
            return value

        playlist = model_schema(PlaylistPayload)
        metadata = model_schema(MetadataPayload)
        evidence = model_schema(Evidence)
        properties["kind"]["enum"] = ["playlist", "metadata", "intake", "lyrics"]
        properties["title"].update(minLength=1, maxLength=200)
        properties["evidence"] = {"type": "array", "maxItems": 20, "items": evidence}
        schema["oneOf"] = [
            {
                "properties": {"kind": {"const": kind}, "payload": payload},
                "required": ["kind", "payload"],
            }
            for kind, payload in (
                ("playlist", playlist),
                ("metadata", metadata),
                ("intake", model_schema(IntakePayload)),
                ("lyrics", model_schema(LyricsPayload)),
            )
        ]
        if definitions:
            schema["$defs"] = definitions
    return schema
