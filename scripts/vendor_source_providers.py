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
SURFACE = {
    "kugou": "Metadata only: no playback signKey, cloud-list mutation or behavior simulation",
    "netease": "Metadata only: no neapi/xeapi, downloaded keys or filesystem token caches",
}


def cut(source, start, end, replacement=""):
    """Pinned upstream markers must match before a provider adaptation is applied."""
    assert source.count(start) == 1 and source.count(end) == 1
    first, last = source.index(start), source.index(end)
    assert first < last
    return source[:first] + replacement + source[last:]


def adapt(provider, relative, source):
    if provider == "kugou":
        if relative == "util/request.js":
            source = source.split("/**\n * 创建并发送云歌单服务")[0]
            source += "module.exports = { createRequest };\n"
            source = cut(source, "// 酷狗云歌单服务", "/**\n * 创建并发送")
            source = source.replace("signKey, ", "")
            source = re.sub(
                r"    if \(options\?\.encryptKey\) \{.*?\n    \}",
                "    if (options.encryptKey) throw new Error('Unsupported plugin operation');",
                source,
                count=1,
                flags=re.DOTALL,
            )
            source = source.replace(
                "const { generateSimulate } = require('./generate_simulate');\n", ""
            )
            source = source.replace("const CryptoJS = require('crypto-js');\n", "")
            source = re.sub(r"^    const webglHash = .*\n", "", source, flags=re.MULTILINE)
            source = source.replace(
                "const { cryptoMd5, rsaEncrypt2, publicLiteRasKey, publicRasKey } = require('./crypto');\n",
                "",
            )
            source = re.sub(
                r"          const \{ edt, sid \} = generateSimulate\(.*?\n          if \(sid\) answer.body.sid = sid;\n",
                "",
                source,
                flags=re.DOTALL,
            )
        elif relative == "util/helper.js":
            source = re.sub(r"const signKey = .*?\n};\n", "", source, count=1, flags=re.DOTALL)
            source = source.replace("  signKey,\n", "")
        elif relative == "util/index.js":
            source = (
                "const { appid, clientver } = require('./config.json');\n"
                "module.exports = { appid, clientver, decodeLyrics: require('./util').decodeLyrics };\n"
            )
        elif relative == "util/util.js":
            source = source.replace("}\n\nmodule.exports =", "};\n\nmodule.exports =")
        elif relative == "util/crypto.js":
            source = source.replace("if (opt?.key && opt?.key)", "if (opt?.key && opt?.iv)")
        return source
    if relative == "util/crypto.js":
        source = source.split("const aesEcbEncrypt =")[0]
        source = cut(source, "const xeapiStaticKey =", "const aesEncrypt =")
        source = source.replace("const zstd = require('./zstd')\n", "")
        source = source.replace("Math.round(Math.random() * 61)", "crypto.randomInt(62)")
        source += "module.exports = { weapi, linuxapi, eapi, decrypt, aesEncrypt, aesDecrypt, eapiReqDecrypt, eapiResDecrypt }\n"
    elif relative == "util/request.js":
        source = cut(
            source,
            "// 预先读取匿名token并缓存",
            "// 预先绑定常用函数和常量",
            "const anonymous_token = ''\n\n",
        )
        source = cut(source, "// neapi 配置过期时", "// 预先定义osMap")
        source = cut(
            source,
            "      case 'xeapi':",
            "      case 'eapi':",
            "      case 'xeapi':\n      case 'neapi':\n        throw new Error('Unsupported plugin operation')\n\n",
        )
        source = cut(source, "        // 空值同样要记下来", "        // debug:")
        source = cut(
            source,
            "          if (use_xeapi) {",
            "          } else if (use_e_r) {",
            "          if (use_e_r) {\n",
        )
        source = source.replace("          } else if (use_e_r) {\n", "")
        source = re.sub(
            r"^const (?:fs|path|tmpPath|registerNeapikey|logger) = .*\n",
            "",
            source,
            flags=re.MULTILINE,
        )
        source = re.sub(r"^const \{ loadNeapiKey \} = .*\n", "", source, flags=re.MULTILINE)
        source = re.sub(
            r"^const (?:XEAPI_DOMAIN|NEAPI_DOMAIN|stringify) = .*\n",
            "",
            source,
            flags=re.MULTILINE,
        )
        source = re.sub(r"^let xeapiSession(?:Id|Key) = .*\n", "", source, flags=re.MULTILINE)
        source = source.replace("  generateRandomChineseIP,\n", "")
        source = source.replace("    const use_xeapi = crypto === 'xeapi'\n", "").replace(
            "    const use_neapi = crypto === 'neapi'\n", ""
        )
        source = source.replace(
            "      data: use_neapi\n        ? encryptData\n        : new URLSearchParams(encryptData).toString(),",
            "      data: new URLSearchParams(encryptData).toString(),",
        )
        source = source.replace("if (use_e_r || use_xeapi || use_neapi)", "if (use_e_r)")
    return source


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
        if provider == "kugou" and relative == "util/config.json":
            # Metadata and lyric requests need only these public platform identifiers.
            # Do not redistribute unused upstream WeChat/QQ identities or secrets.
            platform = json.loads(content)
            content = (
                json.dumps(
                    {
                        key: platform[key]
                        for key in ("appid", "clientver", "liteAppid", "liteClientver")
                    },
                    indent=2,
                )
                + "\n"
            ).encode()
        if relative.endswith(".js"):
            source = adapt(provider, relative, content.decode())
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
        "provider_surface": SURFACE[provider],
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
        previous = destination / "UPSTREAM.json"
        if previous.exists():
            owned = set(json.loads(previous.read_text())["files"]) | {"UPSTREAM.json"}
            for name in owned - output.keys():
                target = destination / name
                if args.check and target.exists():
                    raise ValueError("Obsolete provider source: " + name)
                if not args.check:
                    target.unlink(missing_ok=True)
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
