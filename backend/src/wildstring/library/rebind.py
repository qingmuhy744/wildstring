"""Review and record changes to the source of an existing music track."""

import hashlib
import json
import os
import shutil
import subprocess
from collections import Counter
from contextlib import suppress
from dataclasses import asdict
from pathlib import Path

from fastapi import HTTPException
from mutagen import MutagenError
from mutagen.flac import FLAC, StreamInfo
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from wildstring.library.edits import BASE_FIELDS, Overrides, apply_effective, observe
from wildstring.library.fs import SourceChangedError, fingerprint, open_source
from wildstring.library.import_files import digest
from wildstring.library.lyric_edits import LyricsText
from wildstring.library.lyrics import FLAC_LYRIC_TAGS, flac_lyric_texts, parse_lyrics
from wildstring.library.metadata import read_metadata
from wildstring.library.sidecar import MARKUP, portable_values
from wildstring.library.tag_fields import ID_TAGS

FORMATS = {".flac", ".mp3", ".m4a"}
PORTABLE_TAGS = set(
    """
    title artist artists album albumartist albumartists tracknumber discnumber tracktotal
    totaltracks disctotal totaldiscs composer lyricist arranger vocalist genre releasedate
    date year originaldate originalyear label organization catalognumber catalog_number
""".split()
) | {key.lower() for key, _ in ID_TAGS.values()}
DERIVED_TAGS = {
    "encoder",
    "replaygain_track_gain",
    "replaygain_track_peak",
    "replaygain_album_gain",
    "replaygain_album_peak",
    "replaygain_reference_loudness",
    "replaygain_track_range",
    "replaygain_album_range",
}


class SourceChoice(BaseModel):
    model_config = ConfigDict(extra="forbid")
    track_id: str = Field(min_length=1, max_length=128)
    source_id: str = Field(min_length=1, max_length=64)
    source_path: str = Field(min_length=1, max_length=4096)

    @field_validator("source_path")
    @classmethod
    def relative_media(cls, value):
        path = Path(value)
        if (
            not path.parts
            or path.is_absolute()
            or any(part.startswith(".") for part in path.parts)
            or "\\" in value
            or "\0" in value
            or path.suffix.lower() not in FORMATS
        ):
            raise ValueError("Invalid source audio path")
        return path.as_posix()


class ApprovedBinding(SourceChoice):
    token: str = Field(pattern=r"^[0-9a-f]{64}$")
    bind_only: bool = False


def audio_shape(info):
    return info.sample_rate, info.channels, info.bits_per_sample, info.total_samples


def pcm_digest(database, stream, file_hash):
    with database.connect(scoped=False) as db:
        cached = db.execute(
            "SELECT pcm_sha256 FROM audio_identities WHERE sha256=?", (file_hash,)
        ).fetchone()
    if cached:
        return cached[0]
    tool = shutil.which("ffmpeg")
    if tool is None:
        return None
    stream.seek(0)
    before = fingerprint(os.fstat(stream.fileno()))
    try:
        result = subprocess.run(
            [
                tool,
                "-nostdin",
                "-v",
                "error",
                "-xerror",
                "-f",
                "flac",
                "-i",
                "pipe:0",
                "-map",
                "0:a:0",
                "-c:a",
                "pcm_s32le",
                "-f",
                "hash",
                "-hash",
                "sha256",
                "-",
            ],
            stdin=stream,
            capture_output=True,
            check=True,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if fingerprint(os.fstat(stream.fileno())) != before:
        raise SourceChangedError
    value = result.stdout.decode("ascii").strip()
    with database.connect(write=True) as db:
        db.execute("INSERT OR IGNORE INTO audio_identities VALUES (?,?)", (file_hash, value))
    return value


def flac_equivalent(
    database, managed_stream, source_stream, managed, source, managed_hash, source_hash
):
    if audio_shape(managed.info) != audio_shape(source.info):
        return False
    if managed.info.md5_signature and source.info.md5_signature:
        if managed.info.md5_signature != source.info.md5_signature:
            return False
    decoded = pcm_digest(database, managed_stream, managed_hash)
    return bool(decoded and decoded == pcm_digest(database, source_stream, source_hash))


def fields(metadata):
    return {name: getattr(metadata, name) for name in BASE_FIELDS} | metadata.details


def text_changes(managed, source, managed_meta, source_meta, overrides):
    old_tags, new_tags = dict(managed.tags or []), dict(source.tags or [])
    changed = {
        name
        for name in old_tags.keys() | new_tags.keys()
        if old_tags.get(name) != new_tags.get(name)
    }

    # Padding, encoder identification and seek tables can differ after lossless encoding.
    # Preserve pictures, cue sheets and application blocks before replacing file bytes.
    def assets(audio):
        return [
            (block.code, block.write())
            for block in audio.metadata_blocks
            if block.code not in {0, 1, 3, 4}
        ]

    if changed - PORTABLE_TAGS - DERIVED_TAGS - set(FLAC_LYRIC_TAGS) or assets(managed) != assets(
        source
    ):
        return None
    old = fields(managed_meta)
    new = fields(source_meta)
    delta = {
        key: value
        for key, value in old.items()
        if key not in overrides and key in new and new[key] != value
    }
    if portable_values(delta) != delta:
        return None
    try:
        Overrides.model_validate(delta)
    except ValidationError:
        return None
    return {key: {"value": value, "source": new[key]} for key, value in delta.items()}


def lyric_state(db, track_id):
    return db.execute(
        "SELECT text,selected_candidate,portable_bundle,version FROM track_lyrics WHERE track_id=?",
        (track_id,),
    ).fetchone()


def lyric_change(managed, source):
    old, new = flac_lyric_texts(managed), flac_lyric_texts(source)
    if len(old) != 1 or len(new) > 1 or MARKUP.search(old[0]):
        return None
    try:
        text = LyricsText(text=old[0]).text
    except ValidationError:
        return None
    if parse_lyrics(text, "embedded")["kind"] == "none":
        return None
    return {"value": text, "source": new[0] if new else None}


def read_identity(root, path, *, audio_hint=False, verified=None):
    with open_source(root, path) as stream:
        before = os.fstat(stream.fileno())
        if audio_hint:
            header = stream.read(8)
            if header not in (b"fLaC\x00\x00\x00\x22", b"fLaC\x80\x00\x00\x22"):
                return before, None
            block = stream.read(34)
            if len(block) != 34:
                return before, None
            info = StreamInfo(block)
            key = (*audio_shape(info), info.md5_signature) if info.md5_signature else None
            return before, key
        if verified is not None and fingerprint(before) == fingerprint(verified[0]):
            return before, verified[1]
        value = digest(stream)
        if fingerprint(os.fstat(stream.fileno())) != fingerprint(before):
            raise SourceChangedError
        return before, value


class MusicRebind:
    def __init__(self, database, library_id, root, target, device):
        self.database = database
        self.library_id = library_id
        self.root = root
        self.target = target
        self.device = device
        with database.connect(scoped=False) as db:
            self.sources = {
                row["id"]: Path(row["root"])
                for row in db.execute(
                    "SELECT id,root FROM library_sources WHERE library_id=?", (library_id,)
                )
            }
            self.tracks = {
                row["id"]: dict(row)
                for row in db.execute(
                    """SELECT t.id,t.path,t.title,t.size_bytes,t.mtime_ns,t.sha256,m.version,m.overrides FROM tracks t
                       JOIN track_metadata m ON m.track_id=t.id
                       WHERE t.library_id=? AND t.status='available' ORDER BY t.path""",
                    (library_id,),
                )
                if Path(row["path"]).suffix.lower() in FORMATS
            }
            self.bindings = {
                (row["source_root"], row["source_path"]): row["target_path"]
                for row in db.execute(
                    "SELECT source_root,source_path,target_path FROM imported_files WHERE target_root=?",
                    (str(root),),
                )
            }

    def inspect(self, choice: SourceChoice):
        row = self.tracks.get(choice.track_id)
        source_root = self.sources.get(choice.source_id)
        if row is None or source_root is None:
            raise HTTPException(404, "rebind_file_unavailable")
        path, relative = Path(row["path"]), Path(choice.source_path)
        current = self.bindings.get((str(source_root), choice.source_path))
        if current is not None and current != row["path"]:
            raise HTTPException(409, "rebind_source_in_use")
        overrides = json.loads(row["overrides"])
        changes, observed = {}, None
        lyric_check = {}
        action, reason = "bind", "differentAudio"
        try:
            with (
                open_source(self.root, path) as managed_stream,
                open_source(source_root, relative) as source_stream,
            ):
                managed_stat = os.fstat(managed_stream.fileno())
                source_stat = os.fstat(source_stream.fileno())
                managed_hash, source_hash = digest(managed_stream), digest(source_stream)
                managed_stream.seek(0)
                old_meta = read_metadata(managed_stream, path)
                managed_observed = asdict(old_meta)
                observed = managed_observed
                if managed_hash != source_hash:
                    source_stream.seek(0)
                    new_meta = read_metadata(source_stream, relative)
                if source_stat.st_dev != self.device:
                    reason = "differentVolume"
                elif relative.suffix.lower() != path.suffix.lower():
                    reason = "differentFormat"
                elif managed_hash == source_hash:
                    action, reason = (
                        (
                            "linked"
                            if self.target == self.root
                            and current == row["path"]
                            and os.path.samestat(managed_stat, source_stat)
                            else "exact"
                        ),
                        None,
                    )
                elif path.suffix.lower() == ".flac":
                    managed_stream.seek(0)
                    source_stream.seek(0)
                    managed, source = FLAC(managed_stream), FLAC(source_stream)
                    if flac_equivalent(
                        self.database,
                        managed_stream,
                        source_stream,
                        managed,
                        source,
                        managed_hash,
                        source_hash,
                    ):
                        delta = text_changes(managed, source, old_meta, new_meta, overrides)
                        old_tags, new_tags = managed.tags or {}, source.tags or {}
                        if delta is not None and any(
                            old_tags.get(key) != new_tags.get(key) for key in FLAC_LYRIC_TAGS
                        ):
                            with self.database.connect(scoped=False) as db:
                                lyrics = lyric_state(db, row["id"])
                            lyric_check["lyrics_version"] = lyrics["version"] if lyrics else None
                            if not lyrics or (
                                lyrics["text"] is None
                                and not (lyrics["selected_candidate"] or lyrics["portable_bundle"])
                            ):
                                change = lyric_change(old_tags, new_tags)
                                if change is None:
                                    delta = None
                                else:
                                    delta["lyrics"] = change
                        if delta is None:
                            reason = "unsupportedTags"
                        else:
                            action, reason = "equivalent", None
                            changes, observed = delta, asdict(new_meta)
                else:
                    reason = "differentBytes"
                if fingerprint(os.fstat(managed_stream.fileno())) != fingerprint(
                    managed_stat
                ) or fingerprint(os.fstat(source_stream.fileno())) != fingerprint(source_stat):
                    raise SourceChangedError
        except (OSError, MutagenError, ValueError, SourceChangedError):
            raise HTTPException(409, "rebind_file_unavailable") from None
        plan = {
            "track_id": row["id"],
            "path": row["path"],
            "version": row["version"],
            "source_id": choice.source_id,
            "source_path": choice.source_path,
            "source_root": str(source_root),
            "managed_sha": managed_hash,
            "previous_sha": row["sha256"],
            "source_sha": source_hash,
            "size": source_stat.st_size,
            "action": action,
            "changes": changes,
            "observed": observed,
            "managed_observed": managed_observed,
        }
        if action == "equivalent":
            plan.update(lyric_check)
        token = hashlib.sha256(json.dumps(plan, sort_keys=True).encode()).hexdigest()
        return plan | {"token": token, "reason": reason, "title": row["title"]}

    def public(self, plan):
        return {
            key: plan[key]
            for key in (
                "track_id",
                "title",
                "path",
                "source_id",
                "source_path",
                "action",
                "changes",
                "token",
                "reason",
            )
        }

    def batch(self):
        ids = {str(root): identity for identity, root in self.sources.items()}
        by_path = {row["path"]: row["id"] for row in self.tracks.values()}
        hinted = {}
        for (root, relative), path in self.bindings.items():
            if root in ids and path in by_path and Path(relative).suffix.lower() in FORMATS:
                with suppress(HTTPException, ValidationError):
                    item = self.inspect(
                        SourceChoice(
                            track_id=by_path[path], source_id=ids[root], source_path=relative
                        )
                    )
                    previous = hinted.get(path)
                    if previous is None or (
                        previous["action"] == "bind" and item["action"] != "bind"
                    ):
                        hinted[path] = item
        managed_hashes, managed_audio = {}, {}
        sizes = set()
        for row in self.tracks.values():
            if row["path"] in hinted and hinted[row["path"]]["action"] != "bind":
                continue
            path = Path(row["path"])
            with suppress(OSError, MutagenError, ValueError, SourceChangedError):
                stat = (self.root / path).stat()
                if (stat.st_size, stat.st_mtime_ns) == (row["size_bytes"], row["mtime_ns"]) and row[
                    "sha256"
                ]:
                    value = row["sha256"]
                else:
                    stat, value = read_identity(self.root, path)
                managed_hashes[row["id"]] = value
                sizes.add(stat.st_size)
                if path.suffix.lower() == ".flac":
                    _, key = read_identity(self.root, path, audio_hint=True)
                    if key is not None:
                        managed_audio[row["id"]] = key
        wanted_hashes, wanted_audio = set(managed_hashes.values()), set(managed_audio.values())
        exact, equivalent = {}, {}
        for source_id, root in self.sources.items():
            if not wanted_audio and not wanted_hashes:
                break
            for directory, folders, files in os.walk(root, followlinks=False):
                folders[:] = sorted(name for name in folders if not name.startswith("."))
                for name in sorted(files):
                    path = Path(directory) / name
                    if name.startswith(".") or path.suffix.lower() not in FORMATS:
                        continue
                    relative = path.relative_to(root)
                    candidate = (source_id, relative.as_posix())
                    with suppress(OSError, MutagenError, ValueError, SourceChangedError):
                        if path.lstat().st_size in sizes:
                            _, value = read_identity(root, relative)
                            if value in wanted_hashes:
                                exact.setdefault(value, []).append(candidate)
                        if wanted_audio and path.suffix.lower() == ".flac":
                            _, key = read_identity(root, relative, audio_hint=True)
                            if key in wanted_audio:
                                equivalent.setdefault(key, []).append(candidate)
        proposals, missing = {}, {}
        for identity, row in self.tracks.items():
            path = row["path"]
            binding = hinted.get(path)
            if binding is not None and binding["action"] != "bind":
                proposals[identity] = self.public(binding)
                continue
            for choices in (
                exact.get(managed_hashes.get(identity), ()),
                equivalent.get(managed_audio.get(identity), ()),
            ):
                available = [
                    (source_id, relative)
                    for source_id, relative in choices
                    if self.bindings.get((str(self.sources[source_id]), relative), path) == path
                ]
                if available:
                    break
            if len(available) == 1:
                source_id, relative = available[0]
                with suppress(HTTPException, ValidationError):
                    result = self.inspect(
                        SourceChoice(track_id=identity, source_id=source_id, source_path=relative)
                    )
                    if binding is None or result["action"] != "bind":
                        binding = result
            if binding:
                proposals[identity] = self.public(binding)
            else:
                missing[identity] = "ambiguous" if len(available) > 1 else "noSource"

        claims = Counter((item["source_id"], item["source_path"]) for item in proposals.values())
        for identity, row in self.tracks.items():
            item = proposals.get(identity)
            if item is not None and claims[item["source_id"], item["source_path"]] == 1:
                yield item
                continue
            yield {
                "track_id": identity,
                "title": row["title"],
                "path": row["path"],
                "action": "keep",
                "reason": "ambiguous" if item is not None else missing[identity],
                "changes": {},
            }

    def approve(self, selections):
        items = {}
        sources = set()
        for selection in selections:
            plan = self.inspect(selection)
            if plan["token"] != selection.token:
                raise HTTPException(409, "rebind_preview_changed")
            key = (plan["source_id"], plan["source_path"])
            if key in sources or plan["path"] in items:
                raise HTTPException(409, "rebind_source_in_use")
            sources.add(key)
            if selection.bind_only:
                plan.update(action="bind", changes={}, observed=plan["managed_observed"])
                plan.pop("lyrics_version", None)
            for field in ("managed_observed", "title", "token", "reason"):
                del plan[field]
            items[plan["path"]] = plan
        return items


def check_lyric_version(db, item):
    if "lyrics_version" in item:
        lyrics = lyric_state(db, item["track_id"])
        if (lyrics["version"] if lyrics else None) != item["lyrics_version"]:
            raise ValueError("rebind_preview_changed")


def stage_metadata(db, library_id, item):
    row = db.execute(
        """SELECT m.version,m.overrides FROM tracks t JOIN track_metadata m ON m.track_id=t.id
           WHERE t.id=? AND t.library_id=? AND t.path=? AND t.status='available'""",
        (item["track_id"], library_id, item["path"]),
    ).fetchone()
    if row is None or row["version"] != item["version"]:
        raise ValueError("rebind_preview_changed")
    changes = item["changes"]
    check_lyric_version(db, item)
    if "lyrics" in changes:
        db.execute(
            """INSERT INTO track_lyrics(track_id,text) VALUES (?,?)
               ON CONFLICT(track_id) DO UPDATE SET text=excluded.text,version=track_lyrics.version+1""",
            (item["track_id"], changes["lyrics"]["value"]),
        )
        item["lyrics_version"] = (item["lyrics_version"] or 0) + 1
    text = {key: entry["value"] for key, entry in changes.items() if key != "lyrics"}
    if text:
        overrides = text | json.loads(row["overrides"])
        db.execute(
            "UPDATE track_metadata SET overrides=?,version=version+1 WHERE track_id=?",
            (json.dumps(overrides, ensure_ascii=False), item["track_id"]),
        )
        apply_effective(db, item["track_id"])


def save_binding(db, library_id, target, item, final, *, verified_source=None, linked=None):
    path = item["path"]
    row = db.execute(
        """SELECT id FROM tracks WHERE id=? AND library_id=? AND path=? AND status='available'""",
        (item["track_id"], library_id, path),
    ).fetchone()
    if row is None:
        raise ValueError("rebind_preview_changed")
    source_stat, source_hash = verified_source or read_identity(
        Path(item["source_root"]), Path(item["source_path"])
    )
    if source_hash != item["source_sha"]:
        raise ValueError("rebind_preview_changed")
    key = (item["source_root"], item["source_path"])
    root = str(target)
    collision = db.execute(
        "SELECT target_path FROM imported_files WHERE source_root=? AND source_path=? AND target_root=?",
        (*key, root),
    ).fetchone()
    if collision and collision[0] != path:
        raise ValueError("rebind_source_in_use")
    db.execute("DELETE FROM imported_files WHERE target_root=? AND target_path=?", (root, path))
    if linked is None and item["action"] == "bind":
        linked = os.path.samestat(source_stat, (target / path).stat())
    mode = "managed_only" if item["action"] == "bind" and not linked else "hardlink"
    db.execute(
        """INSERT INTO imported_files
           (source_root,source_path,target_root,target_path,source_size,source_mtime,sha256,link_mode)
           VALUES (?,?,?,?,?,?,?,?)""",
        (*key, root, path, source_stat.st_size, source_stat.st_mtime_ns, source_hash, mode),
    )
    db.execute("UPDATE tracks SET sha256=?,size_bytes=?,mtime_ns=? WHERE id=?", (*final, row["id"]))
    if item["observed"] is not None:
        db.execute(
            "UPDATE tracks SET has_cover = MAX(has_cover, ?) WHERE id=?",
            (int(item["observed"]["has_cover"]), row["id"]),
        )
        observe(db, row["id"], item["observed"])
