"""Convert integer PCM images to verified FLAC tracks without changing source audio."""

import hashlib
import os
import shutil
import subprocess
import threading
import wave
from pathlib import Path

from mutagen import File
from mutagen.flac import FLAC, Picture

from wildstring.library.cue import boundaries
from wildstring.library.scanner import SourceChangedError, fingerprint


def pcm_info(source):
    source.seek(0)
    try:
        with wave.open(source, "rb") as audio:
            info = audio.getparams()
    except (wave.Error, EOFError) as error:
        raise ValueError("wav_not_integer_pcm") from error
    if info.sampwidth not in {2, 3} or not 1 <= info.nchannels <= 8 or info.nframes <= 0:
        raise ValueError("wav_precision_unsupported")
    return info


def binary():
    path = shutil.which("ffmpeg")
    if path is None:
        raise ValueError("ffmpeg_unavailable")
    return path


def convert(source, destination: Path, sheet=None, metadata=None) -> list[Path]:
    before = fingerprint(os.fstat(source.fileno()))
    source.seek(0)
    magic = source.read(4)
    source.seek(0)
    original = File(source)
    pictures = list(original.pictures) if isinstance(original, FLAC) else []
    original_tags = getattr(original, "tags", None)
    if original_tags is not None and hasattr(original_tags, "getall"):
        for frame in original_tags.getall("APIC"):
            picture = Picture()
            picture.type, picture.mime, picture.desc, picture.data = (
                frame.type,
                frame.mime,
                frame.desc,
                frame.data,
            )
            pictures.append(picture)
    if magic == b"fLaC":
        source.seek(0)
        audio = FLAC(source)
        info = audio.info
        rate, channels, width, total = (
            info.sample_rate,
            info.channels,
            info.bits_per_sample // 8,
            info.total_samples,
        )
        if info.bits_per_sample not in {16, 24}:
            raise ValueError("flac_precision_unsupported")
        original_hash = None
    else:
        info = pcm_info(source)
        rate, channels, width, total = info.framerate, info.nchannels, info.sampwidth, info.nframes
        original_hash = hashlib.sha256()
        source.seek(0)
        with wave.open(source, "rb") as audio:
            for chunk in iter(lambda: audio.readframes(262144), b""):
                original_hash.update(chunk)
    ranges = boundaries(sheet, rate, total) if sheet else [(0, total)]
    destination.mkdir(parents=True, exist_ok=True)
    outputs = [destination / f"{i + 1:03d}.flac" for i in range(len(ranges))]
    if any(path.exists() for path in outputs):
        raise ValueError("conversion_destination_exists")
    labels = "".join(f"[s{i}]" for i in range(len(ranges)))
    filters = [f"[0:a:0]asplit={len(ranges)}{labels}"]
    filters.extend(
        f"[s{i}]atrim=start_sample={start}:end_sample={end},asetpts=PTS-STARTPTS[a{i}]"
        for i, (start, end) in enumerate(ranges)
    )
    source.seek(0)
    args = [
        binary(),
        "-nostdin",
        "-v",
        "error",
        "-xerror",
        "-n",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        "pipe:0",
        "-filter_complex",
        ";".join(filters),
    ]
    for i, path in enumerate(outputs):
        args.extend(
            [
                "-map",
                f"[a{i}]",
                "-map_metadata",
                "-1",
                "-c:a",
                "flac",
                "-sample_fmt",
                "s16" if width == 2 else "s32",
                "-compression_level",
                "5",
                str(path),
            ]
        )
    try:
        subprocess.run(
            args,
            stdin=source,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=1800,
            check=True,
        )  # nosec B603
        if fingerprint(os.fstat(source.fileno())) != before:
            raise SourceChangedError
        # Decode all tracks in order and compare the complete PCM stream, including gaps.
        combined = hashlib.sha256()
        sample_bytes = 0
        for i, path in enumerate(outputs):
            audio = FLAC(path)
            if (
                audio.info.sample_rate,
                audio.info.channels,
                audio.info.bits_per_sample,
                audio.info.total_samples,
            ) != (rate, channels, width * 8, ranges[i][1] - ranges[i][0]):
                raise ValueError("flac_parameters_changed")
            codec = "pcm_s16le" if width == 2 else "pcm_s24le"
            args = [
                binary(),
                "-nostdin",
                "-v",
                "error",
                "-xerror",
                "-protocol_whitelist",
                "file,pipe",
                "-i",
                str(path),
                "-c:a",
                codec,
                "-f",
                "s16le" if width == 2 else "s24le",
                "pipe:1",
            ]
            with subprocess.Popen(
                args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
            ) as process:  # nosec B603
                timer = threading.Timer(1800, process.kill)
                timer.start()
                try:
                    for chunk in iter(lambda: process.stdout.read(1024 * 1024), b""):
                        combined.update(chunk)
                        sample_bytes += len(chunk)
                    if process.wait() != 0:
                        raise ValueError("flac_verification_failed")
                finally:
                    timer.cancel()
        if original_hash is None:
            # FLAC input can be piped through a verified temporary image for the same hash check.
            source.seek(0)
            args = [
                binary(),
                "-nostdin",
                "-v",
                "error",
                "-xerror",
                "-protocol_whitelist",
                "file,pipe",
                "-i",
                "pipe:0",
                "-c:a",
                codec,
                "-f",
                "s16le" if width == 2 else "s24le",
                "pipe:1",
            ]
            original_hash = hashlib.sha256()
            with subprocess.Popen(
                args, stdin=source, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
            ) as process:  # nosec B603
                timer = threading.Timer(1800, process.kill)
                timer.start()
                try:
                    for chunk in iter(lambda: process.stdout.read(1024 * 1024), b""):
                        original_hash.update(chunk)
                    if process.wait() != 0:
                        raise ValueError("source_decode_failed")
                finally:
                    timer.cancel()
        if sample_bytes != total * channels * width or combined.digest() != original_hash.digest():
            raise ValueError("pcm_verification_failed")
        if fingerprint(os.fstat(source.fileno())) != before:
            raise SourceChangedError
        for i, path in enumerate(outputs):
            tags = FLAC(path)
            for picture in pictures:
                tags.add_picture(picture)
            if not sheet and original_tags is not None and hasattr(original_tags, "getall"):
                lyrics = [frame.text for frame in original_tags.getall("USLT") if frame.text]
                if lyrics:
                    tags["lyrics"] = lyrics
            fields = dict(metadata or {})
            if sheet:
                track = sheet.tracks[i]
                fields.update(
                    title=track.title,
                    artists=[track.performer or sheet.performer],
                    album=sheet.title,
                    album_artists=[sheet.performer],
                    track_number=track.number,
                    disc_number=fields.get("disc_number") or 1,
                )
            for key, tag in [
                ("title", "title"),
                ("artists", "artist"),
                ("album", "album"),
                ("album_artists", "albumartist"),
                ("track_number", "tracknumber"),
                ("disc_number", "discnumber"),
            ]:
                value = fields.get(key)
                if value:
                    tags[tag] = value if isinstance(value, list) else [str(value)]
            tags.save()
            with path.open("rb") as stream:
                os.fsync(stream.fileno())
        return outputs
    except BaseException as error:
        for path in outputs:
            path.unlink(missing_ok=True)
        if isinstance(error, subprocess.CalledProcessError | subprocess.TimeoutExpired):
            raise ValueError("conversion_failed") from error
        raise
