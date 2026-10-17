"""Deterministic names and letter groups shared by SQL pages and browse indexes."""

import sqlite3
import string
import unicodedata
from functools import lru_cache
from typing import Literal

from pypinyin import Style, lazy_pinyin

from wildstring.library.metadata import normalize

BrowseKind = Literal["tracks", "albums", "artists"]
BROWSE_KEYS = ("0–9", *string.ascii_uppercase, "#")


@lru_cache(maxsize=32768)
def name_order(value: str) -> tuple[str, str]:
    """Use phrase-aware pinyin, then normalized text, without changing display names.

    Unknown scripts and names starting with punctuation stay under #. The pinned
    pypinyin dictionary supplies one reproducible reading for polyphonic phrases.
    The bounded cache is process-local; metadata edits naturally use a new key.
    """
    normalized = normalize(value)
    romanized = "".join(lazy_pinyin(normalized, style=Style.NORMAL))
    romanized = "".join(
        character
        for character in unicodedata.normalize("NFKD", romanized)
        if not unicodedata.combining(character)
    )
    first = romanized[:1].upper()
    if "0" <= first <= "9":
        group = "0–9"
    elif first and first in string.ascii_uppercase:
        group = first
    else:
        group = "#"
    return group, f"{BROWSE_KEYS.index(group):02d}:{romanized}:{normalized}"


def configure_browse_queries(connection: sqlite3.Connection) -> None:
    connection.create_function(
        "browse_group", 1, lambda value: name_order(value)[0], deterministic=True
    )
    connection.create_function(
        "browse_sort", 1, lambda value: name_order(value)[1], deterministic=True
    )
