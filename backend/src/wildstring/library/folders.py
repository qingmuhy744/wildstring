"""Owner-only directory selection and explicit empty-folder creation."""

import os
from contextlib import ExitStack
from pathlib import Path

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from wildstring.library.scanner import open_directory


class FolderCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    parent_path: str = Field(min_length=1, max_length=4096, strict=True)
    name: str = Field(min_length=1, max_length=255, strict=True)


def source_roots(settings, db):
    return [settings.music_dir.resolve()] + [
        Path(row[0]).resolve() for row in db.execute("SELECT root FROM library_sources")
    ]


def creation_policy(directory, roots):
    if any(directory.is_relative_to(root) for root in roots):
        return False, "read_only_source"
    if not os.access(directory, os.W_OK | os.X_OK):
        return False, "not_writable"
    return True, None


def directory_path(value):
    selected = Path(value)
    if (
        not selected.is_absolute()
        or ".." in selected.parts
        or any(path.is_symlink() for path in (selected, *selected.parents))
    ):
        raise HTTPException(422, "folder_path_invalid")
    directory = selected.resolve(strict=True)
    if not directory.is_dir():
        raise HTTPException(404, "folder_not_found")
    return directory


def browse_folders(settings, database, value: str | None = None):
    roots = [
        {"name": "音乐来源（只读）", "path": str(settings.music_dir.resolve())},
        {"name": "托管存储位置", "path": str(settings.library_dir.resolve().parent)},
        {"name": "服务器根目录", "path": "/"},
    ]
    if value is None:
        return {
            "path": None,
            "parent": None,
            "items": roots,
            "truncated": False,
            "can_create": False,
            "creation_blocked_reason": None,
        }
    try:
        directory = directory_path(value)
        with database.connect() as db:
            can_create, blocked_reason = creation_policy(directory, source_roots(settings, db))
        items = []
        truncated = False
        with os.scandir(directory) as entries:
            for entry in entries:
                if entry.name.startswith(".") or entry.is_symlink() or not entry.is_dir():
                    continue
                if len(items) == 500:
                    truncated = True
                    break
                items.append({"name": entry.name, "path": str(directory / entry.name)})
        return {
            "path": str(directory),
            "parent": str(directory.parent) if directory.parent != directory else None,
            "items": sorted(items, key=lambda item: item["name"].casefold()),
            "truncated": truncated,
            "can_create": can_create,
            "creation_blocked_reason": blocked_reason,
        }
    except PermissionError:
        raise HTTPException(403, "folder_not_readable") from None
    except (FileNotFoundError, NotADirectoryError):
        raise HTTPException(404, "folder_not_found") from None
    except (OSError, ValueError, RuntimeError):
        raise HTTPException(422, "folder_path_invalid") from None


def create_folder(settings, database, body: FolderCreate):
    name = body.name
    try:
        size = len(name.encode("utf-8"))
    except UnicodeError:
        raise HTTPException(422, "folder_name_invalid") from None
    if (
        name.startswith(".")
        or any(char in "/\\" or ord(char) < 32 or ord(char) == 127 for char in name)
        or size > 255
    ):
        raise HTTPException(422, "folder_name_invalid")
    try:
        directory = directory_path(body.parent_path)
        with database.connect(write=True) as db:
            # A source cannot be registered between the read-only check and mkdir.
            db.execute("BEGIN IMMEDIATE")
            can_create, reason = creation_policy(directory, source_roots(settings, db))
            if not can_create:
                detail = (
                    "folder_source_read_only"
                    if reason == "read_only_source"
                    else "folder_not_writable"
                )
                raise HTTPException(403, detail)
            with ExitStack() as stack:
                descriptor = stack.enter_context(open_directory(directory.anchor))
                for part in directory.parts[1:]:
                    descriptor = stack.enter_context(open_directory(part, dir_fd=descriptor))
                os.mkdir(name, mode=0o755, dir_fd=descriptor)
        return browse_folders(settings, database, str(directory / name))
    except FileExistsError:
        raise HTTPException(409, "folder_already_exists") from None
    except PermissionError:
        raise HTTPException(403, "folder_not_writable") from None
    except (FileNotFoundError, NotADirectoryError):
        raise HTTPException(404, "folder_not_found") from None
    except (ValueError, RuntimeError):
        raise HTTPException(422, "folder_path_invalid") from None
    except OSError:
        raise HTTPException(503, "folder_create_failed") from None
