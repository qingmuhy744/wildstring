"""Book source ignore rules and plain-text previews."""

import re
import time
from fnmatch import fnmatchcase
from html.parser import HTMLParser
from pathlib import Path
from typing import Annotated

from pydantic import Field, StringConstraints

IgnorePattern = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)
]
IgnorePatterns = Annotated[list[IgnorePattern], Field(max_length=64)]

_TRANSCODER = re.compile(
    r"(?:bilibili vxcode swarm transcoder[^\n]*|lav[fc]\d+(?:\.\d+)+(?:\s+[-\w.]+)?)",
    re.I,
)
_BBCODE_IMAGES = re.compile(r"\[img(?:=[^\]]*)?\].*?(?:\[/img\]|\Z)", re.I | re.S)
_BBCODE_TAGS = re.compile(
    r"\[/?(?:b|i|u|s|color|size|font|align|center|url|quote)(?:=[^\]\n]*)?\]", re.I
)
_DISCLAIMER = re.compile(
    r"仅(?:供|用于).{0,20}(?:试听|试读|学习交流|学习和交流)|"
    r"(?:24|二十四)\s*(?:个\s*)?小时.{0,24}删除|"
    r"版权(?:归|声明)|如有侵权.{0,20}(?:联系|删除)|原抓作品.{0,12}严禁转载|"
    r"for (?:preview|evaluation|listening) (?:use |test )?only|"
    r"only used for listening test|commercial purposes are strictly prohibited|"
    r"delete .{0,16}within 24 hours|all (?:rights reserved|copyrights belong)",
    re.I,
)


def unique_patterns(patterns: list[str]) -> list[str]:
    unique: dict[str, str] = {}
    for pattern in patterns:
        unique.setdefault(pattern.casefold(), pattern)
    return list(unique.values())


def ignored_path(relative: Path, patterns: list[str]) -> bool:
    name = relative.name.casefold()
    path = relative.as_posix().casefold()
    return any(
        fnmatchcase(name, pattern.casefold()) or fnmatchcase(path, pattern.casefold())
        for pattern in patterns
    )


def ignore_pending(db, library_id: str, patterns: list[str], stamp: float | None = None) -> None:
    if not patterns:
        return
    rows = db.execute(
        "SELECT id,relative_path FROM book_scan_skipped_files WHERE library_id=? AND status='pending'",
        (library_id,),
    ).fetchall()
    now = time.time() if stamp is None else stamp
    db.executemany(
        "UPDATE book_scan_skipped_files SET status='ignored',updated_at=? WHERE id=?",
        [(now, row["id"]) for row in rows if ignored_path(Path(row["relative_path"]), patterns)],
    )


class _DescriptionParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts: list[str] = []
        self.hidden: str | None = None

    def handle_starttag(self, tag, attrs):
        if self.hidden is not None:
            return
        if tag in {"script", "style", "iframe", "object", "svg", "template"}:
            self.hidden = tag
        elif tag in {"p", "div", "br", "li", "blockquote", "h1", "h2", "h3"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag == self.hidden:
            self.hidden = None
        elif self.hidden is None and tag in {"p", "div", "li", "blockquote", "h1", "h2", "h3"}:
            self.parts.append("\n")

    def handle_data(self, data):
        if self.hidden is None:
            self.parts.append(data)


def plain_description(value: str) -> str:
    parser = _DescriptionParser()
    parser.feed(value)
    parser.close()
    lines = [" ".join(line.split()) for line in "".join(parser.parts).splitlines()]
    if any(line and not _TRANSCODER.fullmatch(line) for line in lines):
        return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    return ""


def cleaned_preview(value: str) -> str:
    value = _BBCODE_TAGS.sub("", _BBCODE_IMAGES.sub("", value))
    paragraphs = re.split(r"\n[ \t]*\n", value.replace("\r\n", "\n"))
    cleaned = (
        "\n".join(
            line
            for line in paragraph.splitlines()
            if line.strip().casefold() not in {"warning", "warning:"}
            and not _DISCLAIMER.search(line)
        ).strip()
        for paragraph in paragraphs
    )
    return "\n\n".join(filter(None, cleaned))
