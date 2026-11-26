"""File references and readable streams shared by remote storage backends."""

import io
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Protocol


@dataclass(frozen=True)
class RemoteObject:
    id: str
    name: str
    size: int
    version: str
    md5: str | None
    modified: str | None

    @classmethod
    def from_drive(cls, item):
        return cls(
            item["id"],
            item["name"],
            int(item["size"]),
            str(item.get("version") or item.get("modifiedTime") or ""),
            item.get("md5Checksum"),
            item.get("modifiedTime"),
        )


class MediaStore(Protocol):
    def open_range(self, ref: RemoteObject, start: int, end: int) -> AsyncIterator[bytes]:
        raise NotImplementedError

    def materialize(self, ref: RemoteObject, cache_store):
        raise NotImplementedError

    def upload_stream(
        self, folder_id, rel_path: PurePosixPath, stream, size, mime_type
    ) -> RemoteObject:
        raise NotImplementedError

    def list_tree(self, root_folder_id: str) -> dict:
        raise NotImplementedError

    def list_changes(self, root_folder_id: str, page_token: str) -> tuple:
        raise NotImplementedError


class RemoteRangeFile(io.RawIOBase):
    BLOCK = 256 * 1024

    def __init__(self, drive, ref, name):
        self.drive, self.ref, self.name = drive, ref, str(name)
        self.position = 0
        self.blocks = {}
        self.fetched = 0

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=io.SEEK_SET):
        origin = {io.SEEK_SET: 0, io.SEEK_CUR: self.position, io.SEEK_END: self.ref.size}
        position = origin[whence] + offset
        if position < 0:
            raise ValueError("negative seek position")
        self.position = position
        return position

    def readinto(self, buffer):
        remaining = min(len(buffer), self.ref.size - self.position)
        offset = 0
        while remaining > 0:
            block, start = divmod(self.position, self.BLOCK)
            data = self.blocks.get(block)
            if data is None:
                first = block * self.BLOCK
                last = min(first + self.BLOCK, self.ref.size) - 1
                self.fetched += last - first + 1
                if self.fetched > 8 * self.BLOCK:
                    raise ValueError("remote audio metadata exceeds its range budget")
                data = b"".join(self.drive.iter_range(self.ref, first, last))
                self.blocks[block] = data
            count = min(remaining, len(data) - start)
            buffer[offset : offset + count] = data[start : start + count]
            self.position += count
            remaining -= count
            offset += count
        return offset
