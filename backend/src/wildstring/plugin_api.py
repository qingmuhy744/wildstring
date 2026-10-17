"""Stable plugin API v1: manifests, safe error codes and the baseline LRC codec."""

from wildstring.library.lyrics import MAX_LINES, MAX_TEXT_BYTES, parse_lyrics
from wildstring.source_plugins import Manifest, PluginError

__all__ = ["MAX_LINES", "MAX_TEXT_BYTES", "Manifest", "PluginError", "parse_lyrics"]
