#!/usr/bin/env python3
"""Reject a commit message whose last paragraph contains a Co-Authored-By trailer."""

from __future__ import annotations

import sys
from pathlib import Path

SCISSORS = "# ------------------------ >8 ------------------------"


def message_body(text: str) -> str:
    kept: list[str] = []
    for line in text.splitlines():
        if line.strip() == SCISSORS:
            break
        if line.startswith("#"):
            continue
        kept.append(line)
    return "\n".join(kept).strip()


def last_paragraph_has_coauthor(text: str) -> bool:
    body = message_body(text)
    if not body:
        return False
    paragraph = body.split("\n\n")[-1]
    return any(line.lower().startswith("co-authored-by:") for line in paragraph.splitlines())


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: check_commit_msg.py COMMIT_MSG_FILE", file=sys.stderr)
        return 2
    text = Path(argv[1]).read_text(encoding="utf-8")
    if last_paragraph_has_coauthor(text):
        print(
            "commit message: remove the Co-Authored-By trailer from the last paragraph",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
