"""Conservative album identities shared by scans and schema migration."""

import hashlib
import json
from pathlib import PurePosixPath

from wildstring.library.metadata import normalize


def album_key(library_id: str, path: str, title: str | None, album_artists: list[str]) -> str:
    # Explicit album artists allow multi-disc albums to span folders. Without them,
    # keep folders separate rather than merging unrelated releases or compilations.
    identity = (
        ["artists", *sorted(normalize(artist) for artist in album_artists)]
        if title and album_artists
        else ["folder", PurePosixPath(path).parent.as_posix()]
    )
    value = json.dumps([library_id, normalize(title or ""), identity], ensure_ascii=False)
    return hashlib.sha256(value.encode()).hexdigest()
