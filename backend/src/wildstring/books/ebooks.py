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
MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
MAX_IMAGE_BYTES = 8 * 1024 * 1024
AUDIO_SUFFIXES = {".mp3", ".m4a", ".m4b", ".flac", ".ogg", ".opus", ".aac", ".wav", ".mp4", ".webm"}
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
BLOCK_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "blockquote", "pre", "img"}
DISCARDED_TAGS = {"script", "style", "iframe", "object", "embed", "svg", "audio", "video", "head"}


def audio_header(data):
    return (
        data.startswith((b"ID3", b"fLaC", b"OggS", b"\x1a\x45\xdf\xa3"))
        or (data.startswith(b"RIFF") and data[8:12] in {b"WAVE", b"AVI "})
        or data[4:8] == b"ftyp"
        or (len(data) >= 2 and data[0] == 255 and data[1] & 0xE0 == 0xE0)
    )


def validate_upload(name, content_type, data):
    suffix = PurePosixPath(name).suffix.lower()
    if (
        suffix in AUDIO_SUFFIXES
        or content_type.startswith(("audio/", "video/"))
        or audio_header(data)
    ):
        raise HTTPException(422, "audio_upload_forbidden")
    return suffix


def tag(element):
    return element.tag.rsplit("}", 1)[-1]


def asset_path(base, value):
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc or parsed.query or not parsed.path:
        return None
    relative = unquote(parsed.path)
    if relative.startswith("/") or "\\" in relative:
        return None
    name = posixpath.normpath(posixpath.join(posixpath.dirname(base), relative))
    return None if name == ".." or name.startswith("../") else name


def normalized_image(data):
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError("book_image_invalid")
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


def blocks_from_document(document, image_key):
    blocks = []

    def append(kind, text="", image=None):
        if text or image:
            blocks.append(
                {
                    "block_index": len(blocks),
                    "tag": kind,
                    "runs": [{"text": text}] if text else [],
                    "text": text,
                    "char_len": len(text),
                    "image_key": image,
                }
            )

    def walk(element):
        kind = tag(element)
        if kind in DISCARDED_TAGS:
            return
        if kind == "img":
            append(kind, image=image_key(element.get("src", "")))
        elif kind in BLOCK_TAGS:
            append(kind, " ".join(element.itertext()).strip())
            for image in element.iter():
                if tag(image) == "img":
                    walk(image)
        else:
            append("p", (element.text or "").strip())
            for child in element:
                walk(child)
                append("p", (child.tail or "").strip())

    for element in list(document.iter()):
        for child in list(element):
            if tag(child) in DISCARDED_TAGS:
                element.remove(child)
    walk(document)
    return blocks


def parse_epub(stream):
    with ZipFile(stream) as archive:
        files = {}
        infos = archive.infolist()
        if len(infos) > MAX_ENTRIES or sum(info.file_size for info in infos) > MAX_UNPACKED_BYTES:
            raise ValueError("ebook_archive_too_large")
        for info in infos:
            name = info.filename
            path = PurePosixPath(name)
            if (
                path.is_absolute()
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

        def read(name, limit=MAX_DOCUMENT_BYTES):
            if name not in files or files[name].file_size > limit:
                raise ValueError("ebook_archive_invalid")
            return archive.read(files[name])

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
        navigation = ncx_id = None
        metadata = {"authors": []}
        for element in package.iter():
            kind = tag(element)
            if kind == "item":
                media_type = element.get("media-type", "")
                if media_type.startswith(("audio/", "video/")):
                    raise HTTPException(422, "audio_upload_forbidden")
                path = asset_path(package_path, element.get("href", ""))
                items[element.get("id")] = path
                if "nav" in element.get("properties", "").split():
                    navigation = path
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
                    if tag(point) != "navPoint":
                        continue
                    parts = {tag(child): child for child in point}
                    if "content" in parts and "navLabel" in parts:
                        path = asset_path(toc_path, parts["content"].get("src", ""))
                        label = " ".join("".join(parts["navLabel"].itertext()).split())
                        if path in files and label:
                            titles.setdefault(path, label)

        images = {}
        image_keys = {}
        chapters = []
        for ref in spine:
            name = items.get(ref)
            if name is None:
                raise ValueError("ebook_archive_invalid")

            def image_key(value, document_name=name):
                image = asset_path(document_name, value)
                if image not in files or PurePosixPath(image).suffix.lower() not in IMAGE_SUFFIXES:
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
