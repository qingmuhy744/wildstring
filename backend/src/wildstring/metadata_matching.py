"""Stable lookup identity used to decide whether a metadata suggestion is still safe."""

import hashlib
import json

LOOKUP_FIELDS = (
    "title",
    "artists",
    "album",
    "album_artists",
    "duration_ms",
    "external_ids",
)


def lookup_snapshot(track):
    """Return only fields that identify the recording for an online lookup.

    Cosmetic or descriptive edits (cover, genre, description, and so on) must not
    invalidate every candidate.  Lists are copied so callers cannot mutate the
    snapshot after it has been stored with a suggestion.
    """
    snapshot = {}
    for key in LOOKUP_FIELDS:
        value = track.get(key)
        if isinstance(value, list):
            value = list(value)
        elif isinstance(value, dict):
            value = dict(value)
        snapshot[key] = value
    return snapshot


def lookup_fingerprint(track=None, *, snapshot=None):
    value = snapshot if snapshot is not None else lookup_snapshot(track or {})
    raw = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def candidate_matches(track, match):
    fingerprint = match.get("input_fingerprint") if isinstance(match, dict) else None
    return bool(fingerprint and fingerprint == lookup_fingerprint(track))
