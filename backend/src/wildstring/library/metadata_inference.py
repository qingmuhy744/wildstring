"""Inference and sanitization for audio metadata when tags are missing or incomplete."""

import re
from pathlib import Path

from wildstring.library.metadata import Metadata

NOISE_PATTERN = re.compile(
    r"\s*\[.*?(?:flac|hi-res|web|cd|mp3|wav|24bit|16b|lossless|ep|remastered|deluxe).*?\]"
    r"|\s*\{.*?\}"
    r"|\s*\[.*?系列\]"
    r"|\s*[-－—]\s*(?:flac|mp3|wav|m4a|hi-res|lossless)\b",
    re.IGNORECASE,
)
YEAR_PAREN_PATTERN = re.compile(r"[\(（](\d{4})[\)）]")
FRONT_YEAR_PATTERN = re.compile(r"^\[?(\d{4}(?:\d{4}|\.\d{2}\.\d{2})?)\]?\s*[-－—\s]*\s*(.*)$")
DISC_DIR_PATTERN = re.compile(
    r"^(?:cd|disc|disk|part|vol)[_.\s\-]*(\d{1,2})$",
    re.IGNORECASE,
)
TRACK_COMPOSITE_PATTERN = re.compile(
    r"^(?:(?:cd|disc)[_.\s\-]*)?(\d{1,2})[-_](\d{1,3})[\s.\-_]+(.*)$",
    re.IGNORECASE,
)
TRACK_LEADING_PATTERN = re.compile(r"^(\d{1,3})[\s.\-_]+(.*)$")
OLD_RIP_PATTERN = re.compile(r"^(.*?)\.-\.\[(\d{4})[-_]?(.*?)\](?:\.专辑)?", re.IGNORECASE)


def infer_disc_from_path(relative: Path) -> tuple[int | None, Path]:
    """Extract disc number from subfolder (like CD1, Disc 2) and return remaining album dir."""
    parts = relative.parts
    if len(parts) >= 2:
        parent_name = parts[-2]
        match = DISC_DIR_PATTERN.match(parent_name)
        if match:
            disc = int(match.group(1))
            album_dir = Path(*parts[:-2]) if len(parts) > 2 else Path(".")
            return disc, album_dir
    album_dir = Path(*parts[:-1]) if len(parts) > 1 else Path(".")
    return None, album_dir


def sanitize_folder_name(name: str) -> str:
    """Remove trailing technical/source noise from folder name."""
    cleaned = NOISE_PATTERN.sub("", name).strip()
    return cleaned or name


def parse_album_folder(folder_name: str) -> dict[str, str | None]:
    """Infer artist, album, and year from an album folder name."""
    if not folder_name or folder_name in (".", "/", "\\"):
        return {"artist": None, "album": None, "year": None}

    cleaned = sanitize_folder_name(folder_name)

    # 1. Check old rip pattern: 小虎队.-.[1989-男孩不哭].专辑
    rip_match = OLD_RIP_PATTERN.match(cleaned)
    if rip_match:
        artist = rip_match.group(1).strip()
        year = rip_match.group(2)
        album = rip_match.group(3).strip()
        return {"artist": artist or None, "album": album or None, "year": year}

    # 2. Extract year if present
    year = None
    paren_year = YEAR_PAREN_PATTERN.search(cleaned)
    if paren_year:
        year = paren_year.group(1)
        cleaned = YEAR_PAREN_PATTERN.sub("", cleaned).strip()
    else:
        front_year = FRONT_YEAR_PATTERN.match(cleaned)
        if front_year:
            year = front_year.group(1)
            cleaned = front_year.group(2).strip()

    # 3. Split artist and album
    parts = [p.strip() for p in re.split(r"\s*[-－—]\s*", cleaned) if p.strip()]
    if len(parts) == 1:
        return {"artist": None, "album": parts[0], "year": year}
    if len(parts) == 2:
        return {"artist": parts[0], "album": parts[1], "year": year}
    if len(parts) >= 3:
        # Check if middle part is year
        if parts[1].isdigit() and len(parts[1]) == 4:
            return {"artist": parts[0], "album": " - ".join(parts[2:]), "year": parts[1]}
        return {"artist": parts[0], "album": " - ".join(parts[1:]), "year": year}

    return {"artist": None, "album": None, "year": year}


def infer_track_and_title(stem: str) -> tuple[int | None, int | None, str]:
    """Infer track number, disc number, and clean title from audio filename stem."""
    # Composite: 1-01 Song or CD1-02 Song
    composite = TRACK_COMPOSITE_PATTERN.match(stem)
    if composite:
        disc = int(composite.group(1))
        track = int(composite.group(2))
        clean_title = composite.group(3).strip()
        return track, disc, clean_title or stem

    # Standard leading number: 01. Song or 01 - Song or 01 Song
    leading = TRACK_LEADING_PATTERN.match(stem)
    if leading:
        track = int(leading.group(1))
        clean_title = leading.group(2).strip()
        return track, None, clean_title or stem

    # Multipart title: Artist - Album - 01 - Title
    parts = [p.strip() for p in re.split(r"\s*[-－—]\s*", stem) if p.strip()]
    if len(parts) >= 3 and parts[-2].isdigit():
        track = int(parts[-2])
        clean_title = parts[-1]
        return track, None, clean_title or stem

    return None, None, stem


def enrich_metadata(
    metadata: Metadata,
    relative_path: Path,
    *,
    override_artist: str | None = None,
    override_album: str | None = None,
) -> Metadata:
    """Enrich and sanitize metadata using filename and directory context when tags are missing."""
    disc_number = metadata.disc_number
    track_number = metadata.track_number
    title = metadata.title
    title_source = metadata.title_source
    artists = list(metadata.artists)
    album = metadata.album
    album_artists = list(metadata.album_artists)

    # 1. Infer disc and track from filename & path
    path_disc, album_dir = infer_disc_from_path(relative_path)
    if disc_number is None and path_disc is not None:
        disc_number = path_disc

    file_track, file_disc, clean_title = infer_track_and_title(relative_path.stem)
    if disc_number is None and file_disc is not None:
        disc_number = file_disc

    if track_number is None and file_track is not None:
        track_number = file_track
        # If title came from raw filename, use the cleaned title (without track prefix)
        if title_source == "filename":
            title = clean_title

    # 2. Infer album and artist from folder structure
    folder_info = parse_album_folder(album_dir.name)
    if not album:
        album = folder_info.get("album")
    if not artists and folder_info.get("artist"):
        artists = [folder_info["artist"]]
    # If artist still unknown, check parent folder (e.g. Artist/Album structure)
    if not artists and album_dir.parent != Path("."):
        parent_candidate = sanitize_folder_name(album_dir.parent.name)
        if parent_candidate and parent_candidate.lower() not in (
            "music",
            "musicdir",
            "data",
            "download",
            "downloads",
            "upload",
            "uploads",
            "library",
            "audio",
        ):
            artists = [parent_candidate]
    if not album_artists and artists:
        album_artists = list(artists)

    # 3. Apply user explicit overrides
    if override_artist and override_artist.strip():
        artists = [override_artist.strip()]
        album_artists = [override_artist.strip()]
    if override_album and override_album.strip():
        album = override_album.strip()

    details = dict(metadata.details)
    if folder_info.get("year"):
        if not details.get("release_date"):
            details["release_date"] = folder_info["year"]
        if not details.get("original_date"):
            details["original_date"] = folder_info["year"]

    return Metadata(
        title=title,
        title_source=title_source,
        artists=artists,
        album=album,
        album_artists=album_artists,
        track_number=track_number,
        disc_number=disc_number,
        duration_ms=metadata.duration_ms,
        format=metadata.format,
        sample_rate=metadata.sample_rate,
        channels=metadata.channels,
        has_cover=metadata.has_cover,
        details=details,
    )
