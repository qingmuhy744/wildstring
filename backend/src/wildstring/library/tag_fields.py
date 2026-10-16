"""Picard-compatible tag names; file observations remain separate from user edits."""

import re
from datetime import date

from mutagen.flac import FLAC
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4
from mutagen.wave import WAVE

DETAIL_DEFAULTS = {
    "artist_credit": "",
    "album_artist_credit": "",
    "composers": [],
    "lyricists": [],
    "arrangers": [],
    "vocalists": [],
    "genres": [],
    "track_total": None,
    "disc_total": None,
    "release_date": None,
    "original_date": None,
    "external_ids": {},
    "description": "",
    "tags": [],
}
ROLE_FIELDS = {
    "composer": "composers",
    "lyricist": "lyricists",
    "arranger": "arrangers",
    "vocalist": "vocalists",
}
ID_TAGS = {
    "recording": ("MUSICBRAINZ_TRACKID", "MusicBrainz Track Id"),
    "release_track": ("MUSICBRAINZ_RELEASETRACKID", "MusicBrainz Release Track Id"),
    "release": ("MUSICBRAINZ_ALBUMID", "MusicBrainz Album Id"),
    "release_group": ("MUSICBRAINZ_RELEASEGROUPID", "MusicBrainz Release Group Id"),
    "artists": ("MUSICBRAINZ_ARTISTID", "MusicBrainz Artist Id"),
    "album_artists": ("MUSICBRAINZ_ALBUMARTISTID", "MusicBrainz Album Artist Id"),
    "works": ("MUSICBRAINZ_WORKID", "MusicBrainz Work Id"),
}


def valid_date(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}(?:-\d{2}(?:-\d{2})?)?", value):
        return None
    try:
        date.fromisoformat(
            value + ("-01-01" if len(value) == 4 else "-01" if len(value) == 7 else "")
        )
    except ValueError:
        return None
    return value


def unique(values):
    return list(dict.fromkeys(value.strip() for value in values if value.strip()))


class TagReader:
    def __init__(self, audio):
        self.audio = audio
        self.tags = audio.tags or {}
        self.id3 = isinstance(audio, MP3 | WAVE)

    def values(self, vorbis, id3=None, mp4=None):
        if self.id3:
            frame = self.tags.get(id3) if id3 else None
            values = getattr(frame, "text", [])
        elif isinstance(self.audio, FLAC):
            values = self.tags.get(vorbis, [])
        elif isinstance(self.audio, MP4) and mp4:
            values = self.tags.get(mp4, [])
        else:
            values = []
        return unique(
            [
                value.decode("utf-8", errors="replace") if isinstance(value, bytes) else str(value)
                for value in values
            ]
        )

    def custom(self, vorbis, description=None):
        description = description or vorbis
        return self.values(vorbis, f"TXXX:{description}", f"----:com.apple.iTunes:{description}")

    def first(self, vorbis, id3=None, mp4=None):
        return next(iter(self.values(vorbis, id3, mp4)), None)

    def artists(self, *, album=False):
        explicit = self.custom(
            "ALBUMARTISTS" if album else "ARTISTS", "ALBUMARTISTS" if album else "Artists"
        )
        if isinstance(self.audio, MP4) and not album:
            explicit = self.values("ARTISTS", mp4="----:com.apple.iTunes:ARTISTS") or explicit
        return explicit or self.values(
            "ALBUMARTIST" if album else "ARTIST",
            "TPE2" if album else "TPE1",
            "aART" if album else "\xa9ART",
        )

    def total(self, *, disc=False):
        if isinstance(self.audio, MP4):
            pair = self.tags.get("disk" if disc else "trkn", [])
            return int(pair[0][1]) or None if pair else None
        primary = (
            self.first("DISCNUMBER" if disc else "TRACKNUMBER", "TPOS" if disc else "TRCK") or ""
        )
        alternatives = ("DISCTOTAL", "TOTALDISCS") if disc else ("TRACKTOTAL", "TOTALTRACKS")
        candidates = [self.first(name) for name in alternatives] + [primary.partition("/")[2]]
        for text in candidates:
            if text and re.fullmatch(r"\d{1,5}", text.strip()) and int(text) > 0:
                return int(text)
        return None

    def details(self):
        ids = {}
        for name, (vorbis, description) in ID_TAGS.items():
            values = self.custom(vorbis, description)
            if self.id3 and name == "recording":
                frame = self.tags.get("UFID:http://musicbrainz.org")
                if frame is not None:
                    values = [frame.data.decode("ascii", errors="replace")]
            values = [
                value
                for value in values
                if re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", value)
            ]
            if values:
                ids[name] = values if name in {"artists", "album_artists", "works"} else values[0]
        arrangers = self.custom("ARRANGER")
        vocalists = self.custom("VOCALIST")
        if self.id3:
            for key in ("TIPL", "IPLS", "TMCL"):
                for role, person in getattr(self.tags.get(key), "people", []):
                    if role.casefold() == "arranger":
                        arrangers.append(person)
                    if role.casefold() in {"vocals", "vocal", "lead vocals", "vocals (lead)"}:
                        vocalists.append(person)
        return DETAIL_DEFAULTS | {
            "artist_credit": self.first("ARTIST", "TPE1", "\xa9ART") or "",
            "album_artist_credit": self.first("ALBUMARTIST", "TPE2", "aART") or "",
            "composers": self.values("COMPOSER", "TCOM", "\xa9wrt"),
            "lyricists": self.values("LYRICIST", "TEXT", "----:com.apple.iTunes:LYRICIST"),
            "arrangers": unique(arrangers),
            "vocalists": unique(vocalists),
            "genres": self.values("GENRE", "TCON", "\xa9gen"),
            "track_total": self.total(),
            "disc_total": self.total(disc=True),
            "release_date": valid_date(self.first("RELEASEDATE", "TDRL"))
            or valid_date(self.first("DATE", "TDRC", "\xa9day"))
            or valid_date(self.first("YEAR", "TYER")),
            "original_date": valid_date(self.first("ORIGINALDATE", "TDOR"))
            or valid_date(self.first("ORIGINALYEAR", "TORY")),
            "external_ids": ids,
        }
