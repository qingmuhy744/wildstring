"""Decode books into text and re-encoded images for native readers."""

import io
import posixpath
import re
import stat
from pathlib import PurePosixPath
from urllib.parse import unquote, urlsplit
from zipfile import BadZipFile, ZipFile

from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException
from fastapi import HTTPException
from PIL import Image, ImageOps

MAX_EBOOK_BYTES = 256 * 1024 * 1024
MAX_UNPACKED_BYTES = 512 * 1024 * 1024
MAX_ENTRIES = 5000
MAX_SPINE_ITEMS = 1000
MAX_TOTAL_BLOCKS = 200_000
MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
MAX_IMAGE_BYTES = 8 * 1024 * 1024
AUDIO_SUFFIXES = {
    ".mp3",
    ".m4a",
    ".m4b",
    ".flac",
    ".ogg",
    ".opus",
    ".aac",
    ".wav",
    ".mp4",
    ".webm",
    ".wma",
    ".aiff",
    ".aif",
    ".ape",
    ".wv",
    ".caf",
    ".mka",
    ".dsf",
    ".dff",
}
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
IMAGE_FTYP_BRANDS = {b"avif", b"avis", b"heic", b"heix", b"mif1", b"msf1"}
LEAF_BLOCKS = {"h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "pre", "dt", "dd", "figcaption"}
CONTAINERS = {
    "html",
    "body",
    "section",
    "article",
    "main",
    "div",
    "aside",
    "header",
    "footer",
    "nav",
    "ul",
    "ol",
    "dl",
    "figure",
    "blockquote",
}
BLOCK_OR_CONTAINER = LEAF_BLOCKS | CONTAINERS | {"img"}
DISCARDED_TAGS = {"script", "style", "iframe", "object", "embed", "svg", "audio", "video", "head"}
BOLD_TAGS = {"strong", "b"}
ITALIC_TAGS = {"em", "i"}
CODE_TAGS = {"code", "kbd", "samp"}


def _is_utf16_text(data: bytes) -> bool:
    if not data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return False
    sample = data[: len(data) - (len(data) % 2)]
    if len(sample) < 2:
        return False
    try:
        decoded = sample.decode("utf-16")
    except UnicodeDecodeError:
        return False
    return "\x00" not in decoded


def _is_mpeg_or_adts(data: bytes) -> bool:
    if len(data) < 4 or data[0] != 0xFF or (data[1] & 0xE0) != 0xE0:
        return False
    if (data[1] & 0xF6) in {0xF0, 0xF2, 0xF4, 0xF6}:
        return len(data) >= 7
    version = (data[1] >> 3) & 0x03
    layer = (data[1] >> 1) & 0x03
    bitrate = (data[2] >> 4) & 0x0F
    samplerate = (data[2] >> 2) & 0x03
    return version != 0x01 and layer != 0x00 and bitrate not in {0, 0x0F} and samplerate != 0x03


def audio_header(data: bytes) -> bool:
    if _is_utf16_text(data):
        return False
    return (
        data.startswith((b"ID3", b"fLaC", b"OggS", b"\x1a\x45\xdf\xa3"))
        or (data.startswith(b"RIFF") and data[8:12] in {b"WAVE", b"AVI "})
        or (data[4:8] == b"ftyp" and data[8:12] not in IMAGE_FTYP_BRANDS)
        or _is_mpeg_or_adts(data)
    )


def validate_upload(name: str, content_type: str, data: bytes) -> str:
    suffix = PurePosixPath(name).suffix.lower()
    if (
        suffix in AUDIO_SUFFIXES
        or content_type.lower().startswith(("audio/", "video/"))
        or audio_header(data)
    ):
        raise HTTPException(422, "audio_upload_forbidden")
    return suffix


def tag(element) -> str:
    return element.tag.rsplit("}", 1)[-1].lower()


def asset_path(base, value):
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc or parsed.query or not parsed.path:
        return None
    relative = unquote(parsed.path)
    if relative.startswith("/") or "\\" in relative:
        return None
    name = posixpath.normpath(posixpath.join(posixpath.dirname(base), relative))
    return None if name == ".." or name.startswith("../") else name


def normalized_image(data: bytes) -> bytes:
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError("book_image_invalid")
    try:
        with Image.open(io.BytesIO(data)) as source:
            if (
                source.format not in {"JPEG", "PNG", "WEBP"}
                or source.width * source.height > 24_000_000
            ):
                raise ValueError("book_image_invalid")
            image = ImageOps.exif_transpose(source).convert("RGB")
            image.thumbnail((1600, 1600))
            output = io.BytesIO()
            image.save(output, "JPEG", quality=85, optimize=True)
        return output.getvalue()
    except Image.DecompressionBombError as error:
        raise ValueError("book_image_invalid") from error


def _strip_discarded_preserving_tails(document) -> None:
    for element in list(document.iter()):
        previous = None
        for child in list(element):
            if tag(child) in DISCARDED_TAGS:
                if child.tail:
                    if previous is not None:
                        previous.tail = (previous.tail or "") + child.tail
                    else:
                        element.text = (element.text or "") + child.tail
                element.remove(child)
            else:
                previous = child


def _has_nested_block(element) -> bool:
    return any(
        tag(child) in (LEAF_BLOCKS | CONTAINERS) or _has_nested_block(child) for child in element
    )


def _normalize_inline(text: str, *, preformatted: bool) -> str:
    if preformatted:
        return text
    return re.sub(r"\s+", " ", text)


def _trim_runs(runs: list[dict]) -> list[dict]:
    merged: list[dict] = []
    for run in runs:
        if not run["text"]:
            continue
        style = {k: v for k, v in run.items() if k != "text" and v}
        if merged:
            prev_style = {k: v for k, v in merged[-1].items() if k != "text" and v}
            if prev_style == style:
                merged[-1]["text"] += run["text"]
                continue
        merged.append({"text": run["text"], **style})
    while merged:
        stripped = merged[0]["text"].lstrip()
        if stripped:
            merged[0]["text"] = stripped
            break
        merged.pop(0)
    while merged:
        stripped = merged[-1]["text"].rstrip()
        if stripped:
            merged[-1]["text"] = stripped
            break
        merged.pop()
    return merged


def blocks_from_document(document, image_key):
    blocks = []
    _strip_discarded_preserving_tails(document)

    def append_runs(kind: str, runs: list[dict]) -> None:
        cleaned = _trim_runs(runs)
        if not cleaned:
            return
        text = "".join(run["text"] for run in cleaned)
        blocks.append(
            {
                "block_index": len(blocks),
                "tag": kind if kind in LEAF_BLOCKS or kind == "blockquote" else "p",
                "runs": cleaned,
                "text": text,
                "char_len": len(text),
                "image_key": None,
            }
        )

    def append_image(src: str) -> None:
        image = image_key(src)
        if image:
            blocks.append(
                {
                    "block_index": len(blocks),
                    "tag": "img",
                    "runs": [],
                    "text": "",
                    "char_len": 0,
                    "image_key": image,
                }
            )

    def collect_inline(
        node, style: dict[str, bool], current_kind: str, buf: list[dict], *, pre: bool
    ):
        if node.text:
            buf.append({"text": _normalize_inline(node.text, preformatted=pre), **style})
        for child in node:
            kind = tag(child)
            if kind == "img":
                append_runs(current_kind, buf)
                buf.clear()
                append_image(child.get("src", ""))
            elif kind == "br":
                buf.append({"text": "\n", **style})
            else:
                next_style = dict(style)
                if kind in BOLD_TAGS:
                    next_style["bold"] = True
                if kind in ITALIC_TAGS:
                    next_style["italic"] = True
                if kind in CODE_TAGS:
                    next_style["code"] = True
                collect_inline(child, next_style, current_kind, buf, pre=pre or kind == "pre")
            if child.tail:
                buf.append({"text": _normalize_inline(child.tail, preformatted=pre), **style})

    def walk(element, fallback_kind: str = "p") -> None:
        kind = tag(element)
        if kind == "img":
            append_image(element.get("src", ""))
            return
        if kind in LEAF_BLOCKS or (kind in CONTAINERS and not _has_nested_block(element)):
            block_kind = kind if kind in LEAF_BLOCKS or kind == "blockquote" else fallback_kind
            if not _has_nested_block(element):
                buf: list[dict] = []
                collect_inline(element, {}, block_kind, buf, pre=kind == "pre")
                append_runs(block_kind, buf)
                return
        # Container (or leaf containing nested block tags): preserve inline text between blocks.
        buf = []
        if element.text:
            buf.append({"text": _normalize_inline(element.text, preformatted=False)})
        child_fallback = "blockquote" if kind == "blockquote" else fallback_kind
        for child in element:
            ckind = tag(child)
            if ckind in BLOCK_OR_CONTAINER or _has_nested_block(child):
                append_runs(child_fallback, buf)
                buf.clear()
                walk(child, child_fallback)
            elif ckind == "br":
                buf.append({"text": "\n"})
            else:
                next_style: dict[str, bool] = {}
                if ckind in BOLD_TAGS:
                    next_style["bold"] = True
                if ckind in ITALIC_TAGS:
                    next_style["italic"] = True
                if ckind in CODE_TAGS:
                    next_style["code"] = True
                collect_inline(child, next_style, child_fallback, buf, pre=False)
            if child.tail:
                buf.append({"text": _normalize_inline(child.tail, preformatted=False)})
        append_runs(child_fallback, buf)

    walk(document)
    return blocks


def parse_epub(stream):
    with ZipFile(stream) as archive:
        files = {}
        infos = archive.infolist()
        if (
            len(infos) > MAX_ENTRIES
            or sum(max(0, info.file_size) for info in infos) > MAX_UNPACKED_BYTES
        ):
            raise ValueError("ebook_archive_too_large")
        for info in infos:
            name = info.filename
            path = PurePosixPath(name)
            if (
                info.file_size < 0
                or path.is_absolute()
                or ".." in path.parts
                or "\\" in name
                or stat.S_ISLNK(info.external_attr >> 16)
                or name in files
            ):
                raise ValueError("ebook_archive_invalid")
            if info.is_dir():
                continue
            with archive.open(info) as member:
                if path.suffix.lower() in AUDIO_SUFFIXES or audio_header(member.read(4096)):
                    raise HTTPException(422, "audio_upload_forbidden")
            files[name] = info

        unpacked_bytes = 0

        def read(name: str, limit: int = MAX_DOCUMENT_BYTES) -> bytes:
            nonlocal unpacked_bytes
            if name not in files:
                raise ValueError("ebook_archive_invalid")
            with archive.open(files[name]) as member:
                data = member.read(limit + 1)
            if len(data) > limit or unpacked_bytes + len(data) > MAX_UNPACKED_BYTES:
                raise ValueError("ebook_archive_too_large")
            unpacked_bytes += len(data)
            return data

        container = ElementTree.fromstring(read("META-INF/container.xml"))
        package_path = next(
            (
                element.get("full-path")
                for element in container.iter()
                if tag(element) == "rootfile"
            ),
            None,
        )
        if package_path is None:
            raise ValueError("ebook_archive_invalid")
        package = ElementTree.fromstring(read(package_path))
        items = {}
        spine = []
        navigation = ncx_id = cover_item_path = cover_meta_id = None
        metadata = {"authors": []}
        for element in package.iter():
            kind = tag(element)
            if kind == "item":
                media_type = element.get("media-type", "").lower()
                if media_type.startswith(("audio/", "video/")):
                    raise HTTPException(422, "audio_upload_forbidden")
                path = asset_path(package_path, element.get("href", ""))
                item_id = element.get("id")
                items[item_id] = path
                props = element.get("properties", "").split()
                if "nav" in props:
                    navigation = path
                if "cover-image" in props and cover_item_path is None:
                    cover_item_path = path
            elif kind == "meta" and element.get("name", "").lower() == "cover":
                if element.get("content") and cover_meta_id is None:
                    cover_meta_id = element.get("content")
            elif kind == "spine":
                ncx_id = element.get("toc")
            elif kind == "itemref":
                spine.append(element.get("idref"))
            elif kind == "title" and element.text and "title" not in metadata:
                metadata["title"] = element.text.strip()
            elif kind == "creator" and element.text:
                metadata["authors"].append(element.text.strip())
            elif kind in {"language", "publisher", "description"} and element.text:
                metadata[kind] = element.text.strip()

        if len(spine) > MAX_SPINE_ITEMS:
            raise ValueError("ebook_archive_too_large")

        cover_candidate = cover_item_path or (items.get(cover_meta_id) if cover_meta_id else None)
        if cover_candidate and cover_candidate in files:
            if PurePosixPath(cover_candidate).suffix.lower() in IMAGE_SUFFIXES:
                metadata["cover_bytes"] = normalized_image(read(cover_candidate, MAX_IMAGE_BYTES))

        titles = {}
        toc_path = navigation or items.get(ncx_id)
        if toc_path in files:
            try:
                toc = ElementTree.fromstring(read(toc_path))
            except (DefusedXmlException, ElementTree.ParseError, ValueError):
                toc = None
            if toc is not None and navigation is not None:
                toc = next(
                    (
                        entry
                        for entry in toc.iter()
                        if tag(entry) == "nav"
                        and "toc" in entry.get("{http://www.idpf.org/2007/ops}type", "").split()
                    ),
                    None,
                )
                if toc is not None:
                    for link in toc.iter():
                        if tag(link) == "a":
                            path = asset_path(toc_path, link.get("href", ""))
                            label = " ".join("".join(link.itertext()).split())
                            if path in files and label:
                                titles.setdefault(path, label)
            elif toc is not None:
                for point in toc.iter():
                    if tag(point) != "navpoint":
                        continue
                    parts = {tag(child): child for child in point}
                    if "content" in parts and "navlabel" in parts:
                        path = asset_path(toc_path, parts["content"].get("src", ""))
                        label = " ".join("".join(parts["navlabel"].itertext()).split())
                        if path in files and label:
                            titles.setdefault(path, label)

        images = {}
        image_keys = {}
        parsed_docs: dict[str, tuple[list[dict], str]] = {}
        chapters = []
        total_blocks = 0
        for ref in spine:
            name = items.get(ref)
            if name is None:
                raise ValueError("ebook_archive_invalid")

            if name in parsed_docs:
                cached_blocks, cached_title = parsed_docs[name]
                blocks = [dict(block) for block in cached_blocks]
                title = cached_title
            else:

                def image_key(value, document_name=name):
                    image = asset_path(document_name, value)
                    if (
                        image not in files
                        or PurePosixPath(image).suffix.lower() not in IMAGE_SUFFIXES
                    ):
                        return None
                    if image not in image_keys:
                        key = f"{len(images)}.jpg"
                        image_keys[image] = key
                        images[key] = normalized_image(read(image, MAX_IMAGE_BYTES))
                    return image_keys[image]

                document = ElementTree.fromstring(read(name))
                blocks = blocks_from_document(document, image_key)
                title = titles.get(name) or next(
                    (block["text"] for block in blocks if block["tag"].startswith("h")),
                    f"{len(chapters) + 1}",
                )
                parsed_docs[name] = (blocks, title)
            total_blocks += len(blocks)
            if total_blocks > MAX_TOTAL_BLOCKS:
                raise ValueError("ebook_archive_too_large")
            chapters.append({"href": name, "title": title, "blocks": blocks})
        if not chapters:
            raise ValueError("ebook_archive_invalid")
        return metadata, chapters, images, "utf-8"


def parse_txt(stream):
    data = stream.read(MAX_EBOOK_BYTES + 1)
    if len(data) > MAX_EBOOK_BYTES:
        raise ValueError("ebook_too_large")
    encodings = (
        ("utf-16",)
        if data.startswith((b"\xff\xfe", b"\xfe\xff"))
        else ("utf-8-sig", "utf-8", "gb18030", "big5")
    )
    for encoding in encodings:
        try:
            text = data.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise ValueError("ebook_encoding_unsupported")
    if "\0" in text:
        raise ValueError("ebook_encoding_unsupported")
    chapters = []
    blocks = []
    chars = 0
    title = ""
    for line in text.splitlines():
        text_line = line.strip()
        if not text_line:
            continue
        heading = bool(re.fullmatch(r"(?:第.{1,12}[章节卷回].*|chapter\s+\d+.*)", text_line, re.I))
        for start in range(0, len(text_line), 12_000):
            text_block = text_line[start : start + 12_000]
            if blocks and (heading or chars + len(text_block) > 12_000):
                chapters.append({"title": title or f"{len(chapters) + 1}", "blocks": blocks})
                blocks, chars, title = [], 0, ""
            if heading:
                title = text_block
            blocks.append(
                {
                    "block_index": len(blocks),
                    "tag": "h2" if heading else "p",
                    "runs": [{"text": text_block}],
                    "text": text_block,
                    "char_len": len(text_block),
                    "image_key": None,
                }
            )
            chars += len(text_block)
            heading = False
    if blocks:
        chapters.append({"title": title or f"{len(chapters) + 1}", "blocks": blocks})
    if not chapters:
        raise ValueError("ebook_empty")
    return {"authors": []}, chapters, {}, encoding


def parse_ebook(stream, suffix):
    data = stream.read(4096)
    validate_upload(f"book{suffix}", "", data)
    stream.seek(0)
    try:
        return parse_epub(stream) if suffix == ".epub" else parse_txt(stream)
    except (
        BadZipFile,
        DefusedXmlException,
        ElementTree.ParseError,
        RuntimeError,
        ValueError,
        OSError,
    ) as error:
        code = str(error)
        if not re.fullmatch(r"(?:ebook|book_image)_[a-z_]+", code):
            code = "ebook_invalid"
        raise HTTPException(422, code) from error
