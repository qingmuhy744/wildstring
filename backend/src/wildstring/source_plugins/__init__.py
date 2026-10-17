"""Versioned, explicit source adapters. Installed extensions are trusted server code."""

import importlib.util
import json
import shutil
from dataclasses import asdict, dataclass, field


@dataclass(frozen=True)
class Manifest:
    id: str
    name: str
    upstream: str
    license: str
    version: str = "1.0.0"
    api_version: int = 1
    capabilities: tuple = ("metadata", "lyrics", "cover")
    settings: tuple = field(default_factory=tuple)
    entrypoint: str = "adapter:Plugin"
    requires_modules: tuple = field(default_factory=tuple)
    cover_hosts: tuple = field(default_factory=tuple)
    requires_programs: tuple = field(default_factory=tuple)

    def public(self):
        return asdict(self)


class PluginError(Exception):
    def __init__(self, code="source_plugin_unavailable"):
        self.code = code
        super().__init__(code)


def registry(database, directory):
    with database.connect() as db:
        rows = db.execute("SELECT * FROM source_plugin_packages").fetchall()
    return {
        row["plugin_id"]: InstalledPlugin(
            Manifest(**json.loads(row["manifest"])), directory / row["sha256"], row["sha256"]
        )
        for row in rows
    }


class InstalledPlugin:
    def __init__(self, manifest, path, sha256):
        self.manifest, self.path, self.sha256 = manifest, path, sha256

    def available(self):
        return all(
            importlib.util.find_spec(name) is not None
            or (self.path / "lib" / name).is_dir()
            or (self.path / "lib" / (name + ".py")).is_file()
            for name in self.manifest.requires_modules
        ) and all(shutil.which(name) is not None for name in self.manifest.requires_programs)

    def invoke(self, context, method, value):
        from wildstring.plugin_archives import execute

        return execute(self, context, method, value)

    def search(self, context, query):
        return self.invoke(context, "search", query)

    def metadata(self, context, candidate):
        return self.invoke(context, "metadata", candidate)

    def lyrics(self, context, candidate):
        return self.invoke(context, "lyrics", candidate)
