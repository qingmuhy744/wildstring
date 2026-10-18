"""Reproduce the provider-owned metadata subsets from integrity-pinned upstream archives."""

import argparse
import hashlib
import io
import json
import re
import tarfile
from pathlib import Path, PurePosixPath
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = ROOT / "plugins/node-runtime"
UPSTREAMS = {
    "kugou": {
        "url": "https://codeload.github.com/MakcRe/KuGouMusicApi/tar.gz/ba3645f2c89e6b9d4fec82ff783c15287e4c5f43",
        "sha256": "d6534d7b74c0c541ad6d633842e20e0e59c7fa983954bef0a34a1ca57e0123ba",
        "modules": ["search", "krm_audio", "search_lyric", "lyric"],
    },
    "netease": {
        "url": "https://codeload.github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/tar.gz/19c7dad6db7d660954c7a615a686ff0acb030f91",
        "sha256": "cea2f085fe7c3b1185e75b6dcc587250dc2812aad5463944a2fba6ba0a1f0b92",
        "modules": ["cloudsearch", "song_detail", "album", "lyric_new"],
    },
}
REPLACEMENTS = {
    "node-forge": "@wildstring/native-rsa",
    "pac-proxy-agent": "@wildstring/no-pac",
}
REQUIRE = re.compile(r"require\(['\"]([^'\"]+)['\"]\)")
UNSUPPORTED = {"module/register_checktoken_v2.js", "module/register_checktoken_v3.js"}


def normalized(path):
    parts = []
    for part in path.parts:
        if part == "..":
            if not parts:
                raise ValueError("Upstream import escapes package")
            parts.pop()
        elif part != ".":
            parts.append(part)
    return "/".join(parts)


def subset(provider, raw):
    config = UPSTREAMS[provider]
    if hashlib.sha256(raw).hexdigest() != config["sha256"]:
        raise ValueError("Upstream archive checksum mismatch")
    files = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        for entry in archive.getmembers():
            parts = PurePosixPath(entry.name).parts
            if entry.isfile() and len(parts) > 1 and ".." not in parts and entry.size < 4_000_000:
                files["/".join(parts[1:])] = archive.extractfile(entry).read()
    original = json.loads(files["package.json"])
    queue = ["util/request.js", *(f"module/{name}.js" for name in config["modules"])]
    output, dependencies = {}, {}
    while queue:
        relative = queue.pop()
        if relative in output:
            continue
        if relative in UNSUPPORTED:
            output[relative] = (
                b'module.exports = {getToken: async () => {throw new Error("Unsupported plugin operation")}};\n'
            )
            continue
        content = files[relative]
        if relative.endswith(".js"):
            source = content.decode()
            for module in REQUIRE.findall(source):
                if module.startswith("."):
                    base = normalized(PurePosixPath(relative).parent / module)
                    resolved = next(
                        (
                            p
                            for p in [
                                base,
                                base + ".js",
                                base + ".json",
                                base + "/index.js",
                            ]
                            if p in files
                        ),
                        None,
                    )
                    if resolved is None:
                        raise ValueError("Missing upstream module: " + base)
                    queue.append(resolved)
                elif module in REPLACEMENTS:
                    source = source.replace(
                        "'" + module + "'", "'" + REPLACEMENTS[module] + "'"
                    ).replace('"' + module + '"', '"' + REPLACEMENTS[module] + '"')
                    dependencies[REPLACEMENTS[module]] = "1.0.0"
                elif module in original["dependencies"] and module != "url":
                    dependencies[module] = original["dependencies"][module]
            content = ("\n".join(line.rstrip() for line in source.splitlines()) + "\n").encode()
        output[relative] = content
    output["LICENSE"] = files["LICENSE"]
    package = {
        "name": f"@wildstring/{provider}-metadata",
        "version": "1.0.0",
        "private": True,
        "license": "MIT",
        "description": "Reviewed upstream metadata subset; see UPSTREAM.json",
        "dependencies": dict(sorted(dependencies.items())),
    }
    output["package.json"] = (json.dumps(package, indent=2) + "\n").encode()
    provenance = config | {
        "source_whitespace": "trailing whitespace normalized",
        "upstream_version": original["version"],
        "adaptations": REPLACEMENTS,
        "unsupported_modules": sorted(UNSUPPORTED) if provider == "netease" else [],
        "files": {name: hashlib.sha256(data).hexdigest() for name, data in sorted(output.items())},
    }
    output["UPSTREAM.json"] = (json.dumps(provenance, indent=2) + "\n").encode()
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=ROOT / ".cache/source-upstreams")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    for provider, config in UPSTREAMS.items():
        cache = args.cache / (provider + ".tar.gz")
        if not cache.exists():
            with urlopen(config["url"], timeout=45) as response:  # nosec B310 -- fixed HTTPS sources above
                raw = response.read(16_000_001)
            if len(raw) > 16_000_000:
                raise ValueError("Upstream archive too large")
            cache.write_bytes(raw)
        output = subset(provider, cache.read_bytes())
        destination = PACKAGES / "vendor" / (provider + "-metadata")
        for name, data in output.items():
            target = destination / name
            if args.check:
                if not target.is_file() or target.read_bytes() != data:
                    raise ValueError("Vendored source differs: " + str(target.relative_to(ROOT)))
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
        print(provider + ": " + str(len(output)) + " verified source files")


if __name__ == "__main__":
    main()
