#!/usr/bin/env python3
"""Check local Markdown links, plan states and archived-guide entry points."""

from __future__ import annotations

import re
import subprocess
import sys
import unicodedata
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent.parent
LINK = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
FENCE = re.compile(r"^\s*(`{3,}|~{3,})")
INLINE_CODE = re.compile(r"`[^`]*`")
EXTERNAL = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")
PLAN_STATUS = re.compile(r"状态：(?:草案|已确认|已实施|已取消|已交付于 PR #[0-9]+)")
ARCHIVED_STATUS = "状态：已归档，不代表现行实现。"


def markdown_files() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    return sorted(
        ROOT / name.decode()
        for name in result.stdout.split(b"\0")
        if name and (ROOT / name.decode()).is_file()
    )


def slug(heading: str) -> str:
    heading = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", heading)
    heading = re.sub(r"[`*_~]", "", heading).strip().lower()
    return "".join(
        "-" if char in (" ", "-") else char
        for char in heading
        if char in (" ", "-", "_") or unicodedata.category(char)[0] in ("L", "N")
    )


def anchors(path: Path) -> set[str]:
    result: set[str] = set()
    seen: dict[str, int] = {}
    fence: tuple[str, int] | None = None
    for line in path.read_text(encoding="utf-8").splitlines():
        match = FENCE.match(line)
        if match:
            marker = match.group(1)
            if fence is None:
                fence = (marker[0], len(marker))
            elif marker[0] == fence[0] and len(marker) >= fence[1]:
                fence = None
            continue
        if fence is not None:
            continue
        match = re.match(r"^#{1,6}\s+(.+?)\s*$", line)
        if match:
            value = slug(match.group(1))
            seen[value] = seen.get(value, -1) + 1
            result.add(value if seen[value] == 0 else f"{value}-{seen[value]}")
    return result


def content_lines(path: Path) -> list[tuple[int, str]]:
    result = []
    fence: tuple[str, int] | None = None
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        match = FENCE.match(line)
        if match:
            marker = match.group(1)
            if fence is None:
                fence = (marker[0], len(marker))
            elif marker[0] == fence[0] and len(marker) >= fence[1]:
                fence = None
            continue
        if fence is None:
            result.append((number, line))
    return result


def link_target(raw: str) -> str:
    raw = raw.strip()
    if raw.startswith("<") and ">" in raw:
        return raw[1 : raw.index(">")]
    return raw.split()[0]


def check_links(files: list[Path]) -> tuple[list[str], int, int]:
    problems = []
    total_links = 0
    anchor_links = 0
    anchor_cache: dict[Path, set[str]] = {}
    for path in files:
        relative = path.relative_to(ROOT)
        for number, line in content_lines(path):
            for match in LINK.finditer(INLINE_CODE.sub("", line)):
                raw = link_target(match.group(1))
                if not raw or EXTERNAL.match(raw) or raw.startswith("//"):
                    continue
                total_links += 1
                decoded = unquote(raw)
                path_part, separator, fragment = decoded.partition("#")
                if path_part:
                    target = (
                        Path(path_part)
                        if Path(path_part).is_absolute()
                        else (path.parent / path_part).resolve()
                    )
                else:
                    target = path.resolve()
                if not target.exists():
                    problems.append(f"{relative}:{number}: missing local target: {raw}")
                    continue
                if not separator or not fragment or target.suffix.lower() != ".md":
                    continue
                if re.match(r"^L\d+$", fragment):
                    continue
                anchor_links += 1
                if target not in anchor_cache:
                    anchor_cache[target] = anchors(target)
                if (
                    fragment.lower() not in anchor_cache[target]
                    and slug(fragment) not in anchor_cache[target]
                ):
                    problems.append(f"{relative}:{number}: missing heading anchor: {raw}")
    return problems, total_links, anchor_links


def check_states(files: list[Path]) -> list[str]:
    problems = []
    for path in files:
        relative = path.relative_to(ROOT)
        lines = path.read_text(encoding="utf-8").splitlines()
        if relative.parent == Path("docs/plans") and path.name != "README.md":
            if not lines or not PLAN_STATUS.fullmatch(lines[0]):
                problems.append(f"{relative}:1: expected a valid plan state on the first line")
        for index, line in enumerate(lines):
            if line == "状态：归档，不代表现行实现。":
                problems.append(f"{relative}:{index + 1}: use the complete archived-guide header")
            if line == "状态：现行行为。":
                problems.append(
                    f"{relative}:{index + 1}: current documents do not need a current-state line"
                )
            if line != ARCHIVED_STATUS:
                continue
            following = lines[index + 1 : index + 3]
            if (
                len(following) != 2
                or not following[0].startswith("归档原因：")
                or not following[1].startswith("现行入口：")
            ):
                problems.append(
                    f"{relative}:{index + 1}: archived status must be followed by 归档原因 and 现行入口"
                )
    return problems


def main() -> int:
    files = markdown_files()
    link_problems, total_links, anchor_links = check_links(files)
    problems = link_problems + check_states(files)
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        print(f"{len(problems)} documentation problem(s) found.", file=sys.stderr)
        return 1
    print(
        f"Documentation checks passed: {len(files)} files, "
        f"{total_links} local links, {anchor_links} heading links."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
