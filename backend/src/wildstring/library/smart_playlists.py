"""Bounded Navidrome-style rule subset compiled to parameterized SQLite expressions."""

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

TEXT = {"title": "t.title", "album": "t.album", "filetype": "t.format"}
ARRAY = {"artist": "t.artists", "albumartist": "t.album_artists"}
NUMBER = {
    "duration": "t.duration_ms / 1000.0",
    "playCount": "t.play_count",
    "listened": "t.listened_ms / 1000.0",
}
DATES = {"lastPlayed": "t.last_played_at", "dateAdded": "t.added_at", "dateLoved": "t.loved_at"}
SORT = {**TEXT, **NUMBER, **DATES, "artist": "t.artists"}


class SmartDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    all: list[dict] | None = None
    any: list[dict] | None = None
    sort: Literal[
        "title",
        "artist",
        "album",
        "duration",
        "playCount",
        "listened",
        "lastPlayed",
        "dateAdded",
        "dateLoved",
    ] = "title"
    order: Literal["asc", "desc"] = "asc"
    limit: int = Field(default=200, ge=1, le=5000, strict=True)

    @model_validator(mode="after")
    def valid_rules(self):
        if (self.all is None) == (self.any is None):
            raise ValueError("Specify exactly one of all or any")
        compile_rules({"all": self.all} if self.all is not None else {"any": self.any})
        return self


def compile_rules(root: dict) -> tuple[str, dict]:
    parameters = {}
    visited = 0

    def bind(value):
        key = f"rule_{len(parameters)}"
        parameters[key] = value
        return ":" + key

    def expression(node, depth=0):
        nonlocal visited
        visited += 1
        if depth > 5 or visited > 50 or not isinstance(node, dict) or len(node) != 1:
            raise ValueError("Rules are limited to 50 nodes and depth 5")
        operator, payload = next(iter(node.items()))
        if operator in ("all", "any"):
            if not isinstance(payload, list) or not 1 <= len(payload) <= 30:
                raise ValueError("Each group needs 1 to 30 rules")
            separator = " AND " if operator == "all" else " OR "
            return "(" + separator.join(expression(child, depth + 1) for child in payload) + ")"
        if not isinstance(payload, dict) or len(payload) != 1:
            raise ValueError("A rule needs exactly one field")
        field, value = next(iter(payload.items()))
        if field == "loved":
            if operator not in ("is", "isNot") or type(value) is not bool:
                raise ValueError("Loved supports is/isNot with a boolean")
            return f"(t.loved = {bind(value if operator == 'is' else not value)})"
        if field in TEXT or field in ARRAY:
            if (
                operator not in ("is", "isNot", "contains", "notContains", "startsWith", "endsWith")
                or not isinstance(value, str)
                or len(value) > 256
            ):
                raise ValueError("Invalid text rule")
            from wildstring.library.metadata import normalize

            literal = normalize(value)
            negative = operator in ("isNot", "notContains")
            sql_operator = "=" if operator in ("is", "isNot") else "LIKE"
            if sql_operator == "LIKE":
                literal = literal.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")
                literal = (
                    ("" if operator == "startsWith" else "%")
                    + literal
                    + ("" if operator == "endsWith" else "%")
                )
            clause = f"normalized(COALESCE({TEXT.get(field, 'credit.value')}, '')) {sql_operator} {bind(literal)}"
            if sql_operator == "LIKE":
                clause += " ESCAPE '\\'"
            if field in ARRAY:
                clause = "".join(
                    (
                        "EXISTS (SELECT 1 FROM json_each(",
                        ARRAY[field],
                        ") credit WHERE ",
                        clause,
                        ")",
                    )
                )
            return f"({'NOT ' if negative else ''}({clause}))"
        if field in NUMBER:

            def numeric(item):
                if type(item) not in (int, float) or not math.isfinite(item) or abs(item) > 1e12:
                    raise ValueError("Invalid numeric rule")
                return bind(item)

            if operator in ("is", "isNot", "gt", "lt"):
                comparison = {"is": "=", "isNot": "!=", "gt": ">", "lt": "<"}[operator]
                return f"({NUMBER[field]} {comparison} {numeric(value)})"
            if operator == "inTheRange" and isinstance(value, list) and len(value) == 2:
                low, high = numeric(value[0]), numeric(value[1])
                if value[0] > value[1]:
                    raise ValueError("Invalid range")
                return f"({NUMBER[field]} BETWEEN {low} AND {high})"
        if (
            field in DATES
            and operator in ("inTheLast", "notInTheLast")
            and type(value) is int
            and 1 <= value <= 36500
        ):
            threshold = bind(f"-{value} days")
            clause = f"julianday({DATES[field]}) >= julianday('now', {threshold})"
            return (
                f"({clause})"
                if operator == "inTheLast"
                else f"({DATES[field]} IS NULL OR NOT ({clause}))"
            )
        raise ValueError("Unsupported field or operator")

    return expression(root), parameters
