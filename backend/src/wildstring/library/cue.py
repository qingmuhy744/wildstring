"""Bounded CUE parsing; positions remain integer CD frames until validation."""

import re
import shlex
from dataclasses import dataclass, field
from pathlib import PurePosixPath

from wildstring.library.lyrics import decode_text


@dataclass
class CueTrack:
    number: int
    file: str
    title: str = ""
    performer: str = ""
    indexes: dict[int, int] = field(default_factory=dict)


@dataclass
class CueSheet:
    title: str = ""
    performer: str = ""
    tracks: list[CueTrack] = field(default_factory=list)


def parse_cue(data: bytes) -> CueSheet:
    text = decode_text(data)
    if text is None:
        raise ValueError("cue_encoding")
    sheet = CueSheet()
    current = None
    filename = None
    for line in text.splitlines():
        # CUE quoted Windows paths must not be interpreted as shell escapes.
        lexer = shlex.shlex(line, posix=True)
        lexer.whitespace_split = True
        lexer.escape = ""
        words = list(lexer)
        if not words:
            continue
        command, *args = words
        command = command.upper()
        if command == "FILE":
            if len(args) != 2:
                raise ValueError("cue_file")
            name = args[0].replace("\\", "/")
            path = PurePosixPath(name)
            if path.is_absolute() or ".." in path.parts or ":" in name or not path.parts:
                raise ValueError("cue_path")
            filename, current = path.as_posix(), None
        elif command == "TRACK":
            if len(args) != 2 or args[1].upper() != "AUDIO" or filename is None:
                raise ValueError("cue_track")
            number = int(args[0])
            if not 1 <= number <= 999 or any(t.number >= number for t in sheet.tracks):
                raise ValueError("cue_track_order")
            current = CueTrack(number, filename)
            sheet.tracks.append(current)
        elif command in {"TITLE", "PERFORMER"}:
            if len(args) != 1 or len(args[0]) > 1000:
                raise ValueError("cue_text")
            setattr(current if current else sheet, command.lower(), args[0])
        elif command == "INDEX":
            if current is None or len(args) != 2:
                raise ValueError("cue_index")
            index = int(args[0])
            match = re.fullmatch(r"(\d{1,4}):([0-5]\d):([0-7]\d)", args[1])
            if index not in {0, 1} or not match or int(match[3]) >= 75:
                raise ValueError("cue_index")
            if index in current.indexes:
                raise ValueError("cue_duplicate_index")
            minutes, seconds, frames = map(int, match.groups())
            current.indexes[index] = (minutes * 60 + seconds) * 75 + frames
        elif command in {"PREGAP", "POSTGAP"}:
            # These synthesize silence rather than pointing into the audio image.
            raise ValueError("cue_synthetic_gap")
    if not sheet.tracks or len(sheet.tracks) > 99:
        raise ValueError("cue_track_count")
    for track in sheet.tracks:
        if 1 not in track.indexes or track.indexes.get(0, 0) > track.indexes[1]:
            raise ValueError("cue_missing_index")
    return sheet


def boundaries(sheet: CueSheet, rate: int, total: int) -> list[tuple[int, int]]:
    if len({track.file for track in sheet.tracks}) != 1:
        raise ValueError("cue_multiple_images")
    starts = []
    for track in sheet.tracks:
        frame = track.indexes[1]
        if frame * rate % 75:
            raise ValueError("cue_inexact_sample")
        starts.append(frame * rate // 75)
    if starts[0] != 0:
        raise ValueError("cue_hidden_pregap")
    if any(a >= b for a, b in zip(starts, starts[1:], strict=False)) or starts[-1] >= total:
        raise ValueError("cue_out_of_bounds")
    # INDEX 00 gaps are appended to the preceding track; no audio samples disappear.
    for previous, track in zip(starts, sheet.tracks[1:], strict=False):
        if track.indexes.get(0, track.indexes[1]) * rate < previous * 75:
            raise ValueError("cue_index_order")
    return list(zip(starts, [*starts[1:], total], strict=True))
