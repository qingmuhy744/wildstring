"""Adapters for community projects; these are not official music-platform APIs.

QQMusicApi is a pinned runtime dependency. KuGouMusicApi and
NeteaseCloudMusicApiEnhanced modules ship in the ZIP; external services are optional.
"""

import asyncio
import importlib.util
import json
import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlencode, urlsplit

from wildstring.plugin_api import Manifest, PluginError

BRIDGE_SETTINGS = (
    {"key": "base_url", "label": "外部服务地址（可选，留空使用插件内置）", "type": "url"},
    {"key": "cookie", "label": "平台 Cookie（可选，留空保留）", "type": "secret"},
)


def clean(value):
    import re

    return re.sub(r"<[^>]*>", "", str(value or "")).strip()[:1000]


def bridge(context, path, parameters):
    if context.data["config"].get("base_url"):
        return context.bridge(path, parameters)
    environment = dict(os.environ)
    environment["TMPDIR"] = str(context.directory)
    mode = context.data["proxy_mode"]
    proxy = context.data.get("proxy_url") if mode == "manual" else None
    if mode != "environment":
        for key in (
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ):
            environment[key] = proxy or ""
    environment["KUGOU_API_PROXY"] = (
        proxy or (environment.get("HTTPS_PROXY") if mode == "environment" else "") or ""
    )
    result = subprocess.run(
        ["node", str(Path(__file__).with_name("service.cjs"))],
        input=json.dumps(
            {
                "path": path,
                "parameters": parameters,
                "cookie": context.data["secrets"].get("cookie") or "",
            }
        ).encode(),
        capture_output=True,
        timeout=35,
        check=False,
        cwd=context.directory,
        env=environment,
    )
    if result.returncode or len(result.stdout) > 2 * 1024 * 1024:
        raise PluginError("source_plugin_worker_failed")
    try:
        value = json.loads(result.stdout)
        if (
            not isinstance(value, dict)
            or value.get("code") not in (None, 0, 200)
            or value.get("error_code") not in (None, 0)
        ):
            raise ValueError
        return value
    except ValueError:
        raise PluginError("source_plugin_auth_or_rejected") from None


def positive(value):
    try:
        number = int(value)
        return number if 0 < number <= 99999 else None
    except (ValueError, TypeError):
        return None


class QQTransport:
    def __init__(self, context):
        self.context = context

    async def request(self, prepared):
        if urlsplit(prepared.url).hostname not in {
            "u.y.qq.com",
            "c.y.qq.com",
            "c6.y.qq.com",
            "api.tencentmusic.com",
        }:
            raise PluginError("source_plugin_endpoint_rejected")
        options = prepared.kwargs
        url = prepared.url
        if options.get("params"):
            url += ("&" if "?" in url else "?") + urlencode(options["params"])
        payload = options.get("json")
        result = await asyncio.to_thread(
            self.context.http, url, payload=payload, headers=options.get("headers")
        )

        class Response:
            status_code = 200
            cookies = {}
            headers = {}
            content = json.dumps(result).encode()
            text = content.decode()

            def json(self):
                return result

            def raise_for_status(self):
                return None

        response = Response()
        response.url = url
        return response

    async def close(self):
        pass


class QQPlugin:
    manifest = Manifest(
        "qqmusic",
        "QQ 音乐 / QQMusicApi",
        "https://github.com/L-1124/QQMusicApi",
        "GPL-3.0-only",
        version="0.8.2",
        requires_modules=("qqmusic_api",),
        cover_hosts=("gtimg.cn",),
    )

    def available(self):
        return importlib.util.find_spec("qqmusic_api") is not None

    def call(self, context, operation, value):
        if not self.available():
            raise PluginError("source_plugin_dependency_missing")
        from qqmusic_api import Client

        async def run():
            async with Client(
                transport=QQTransport(context),
                max_concurrency=1,
                device_path=str(context.directory / "qqmusic-device.json"),
            ) as client:
                if operation == "search":
                    response = await client.search.search_by_type(
                        keyword=value, num=3, highlight=False
                    )
                elif operation == "song":
                    response = await client.song.get_detail(value)
                elif operation == "album":
                    response = await client.album.get_detail(value)
                else:
                    response = await client.lyric.get_lyric(value, qrc=True, trans=True, roma=True)
                return response.model_dump(mode="json")

        return asyncio.run(asyncio.wait_for(run(), timeout=35))

    def search(self, context, query):
        return self.call(context, "search", query).get("song", [])[:3]

    def metadata(self, context, candidate):
        song = self.call(context, "song", candidate["mid"])["track"]
        album = song.get("album") or {}
        details = self.call(context, "album", album["mid"]) if album.get("mid") else {}
        release = details.get("album") or album
        fields = {
            "title": clean(song.get("title") or song["name"]),
            "artists": [clean(a["name"]) for a in song.get("singer", [])],
            "album": clean(release.get("name") or album.get("name")),
        }
        if release.get("time_public"):
            fields["release_date"] = release["time_public"]
        if release.get("genre"):
            fields["genres"] = [clean(release["genre"])]
        for field, key in (("track_number", "index_album"), ("disc_number", "index_cd")):
            if positive(song.get(key)):
                fields[field] = positive(song[key])
        mid = album.get("mid")
        return {
            "id": song["mid"],
            "release_id": mid,
            "title": fields["title"],
            "artists": fields["artists"],
            "duration_ms": int(song.get("interval", 0)) * 1000,
            "fields": fields,
            "source_url": f"https://y.qq.com/n/ryqq/songDetail/{song['mid']}",
            "cover_url": f"https://y.gtimg.cn/music/photo_new/T002R500x500M000{mid}.jpg"
            if mid
            else None,
            "raw": {"song": song, "album": details},
        }

    def lyrics(self, context, candidate):
        data = self.call(context, "lyrics", candidate["id"])
        return {
            "format": "qrc",
            "original": data.get("lyric", ""),
            "translation": data.get("trans", ""),
            "romanization": data.get("roma", ""),
        }


class NeteasePlugin:
    manifest = Manifest(
        "netease",
        "网易云音乐 / API Enhanced",
        "https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced",
        "GPL-3.0-only",
        settings=BRIDGE_SETTINGS,
        cover_hosts=("music.126.net",),
        requires_programs=("node",),
    )

    def available(self):
        return True

    def search(self, context, query):
        return (
            bridge(context, "/cloudsearch", {"keywords": query, "type": 1, "limit": 3})
            .get("result", {})
            .get("songs", [])[:3]
        )

    def metadata(self, context, candidate):
        result = bridge(context, "/song/detail", {"ids": str(candidate["id"])})
        song = result["songs"][0]
        album = song.get("al") or song.get("album") or {}
        details = bridge(context, "/album", {"id": album["id"]}).get("album") or album
        fields = {
            "title": clean(song["name"]),
            "artists": [clean(a["name"]) for a in (song.get("ar") or song.get("artists") or [])],
            "album": clean(details.get("name")),
        }
        if details.get("publishTime", 0) > 0:
            fields["release_date"] = (
                datetime.fromtimestamp(details["publishTime"] / 1000, UTC).date().isoformat()
            )
        if positive(song.get("no")):
            fields["track_number"] = positive(song["no"])
        if positive(song.get("cd")):
            fields["disc_number"] = positive(song["cd"])
        return {
            "id": str(song["id"]),
            "release_id": str(album["id"]),
            "title": fields["title"],
            "artists": fields["artists"],
            "duration_ms": int(song.get("dt") or song.get("duration") or 0),
            "fields": fields,
            "source_url": f"https://music.163.com/song?id={song['id']}",
            "cover_url": details.get("picUrl"),
            "raw": {"song": song, "album": details},
        }

    def lyrics(self, context, candidate):
        data = bridge(context, "/lyric/new", {"id": candidate["id"]})
        original = data.get("yrc", {}).get("lyric") or data.get("lrc", {}).get("lyric", "")
        return {
            "format": "yrc" if data.get("yrc", {}).get("lyric") else "lrc",
            "original": original,
            "translation": (data.get("ytlrc") or data.get("tlyric") or {}).get("lyric", ""),
            "romanization": (data.get("yromalrc") or data.get("romalrc") or {}).get("lyric", ""),
        }


class KuGouPlugin:
    manifest = Manifest(
        "kugou",
        "酷狗音乐 / KuGouMusicApi",
        "https://github.com/MakcRe/KuGouMusicApi",
        "GPL-3.0-only",
        settings=BRIDGE_SETTINGS,
        cover_hosts=("kugou.com",),
        requires_programs=("node",),
    )

    def available(self):
        return True

    def search(self, context, query):
        result = bridge(context, "/search", {"keywords": query, "type": "song", "pagesize": 3})
        data = result.get("data") or {}
        return (data.get("lists") or data.get("info") or [])[:3]

    def metadata(self, context, candidate):
        identity = str(
            candidate.get("MixSongID")
            or candidate.get("mixsongid")
            or candidate.get("mixsongid".upper())
            or candidate.get("AlbumAudioID")
            or ""
        )
        data = (
            bridge(
                context,
                "/krm/audio",
                {"album_audio_id": identity, "fields": "album_info,base,authors.base"},
            ).get("data")
            or []
        )
        record = data[0] if isinstance(data, list) and data else data
        base = record.get("base") or {}
        album = record.get("album_info") or {}
        artists = [
            clean(a.get("base", a).get("author_name") or a.get("base", a).get("name"))
            for a in record.get("authors", [])
        ]
        fields = {
            "title": clean(
                base.get("audio_name") or candidate.get("SongName") or candidate.get("FileName")
            ),
            "artists": artists
            or [clean(a) for a in str(candidate.get("SingerName", "")).split("、") if a.strip()],
            "album": clean(album.get("album_name") or candidate.get("AlbumName")),
        }
        if album.get("publish_date"):
            fields["release_date"] = str(album["publish_date"])[:10]
        return {
            "id": identity,
            "hash": candidate.get("FileHash") or candidate.get("hash") or base.get("hash"),
            "release_id": str(album.get("album_id") or candidate.get("AlbumID") or ""),
            "title": fields["title"],
            "artists": fields["artists"],
            "duration_ms": int(candidate.get("Duration") or candidate.get("duration") or 0) * 1000,
            "fields": fields,
            "source_url": f"https://www.kugou.com/song/#hash={candidate.get('FileHash') or candidate.get('hash') or ''}",
            "cover_url": (album.get("sizable_cover") or album.get("cover") or "").replace(
                "{size}", "500"
            )
            or None,
            "raw": record,
        }

    def lyrics(self, context, candidate):
        found = bridge(
            context,
            "/search/lyric",
            {
                "keywords": candidate["title"] + " " + " ".join(candidate["artists"]),
                "hash": candidate.get("hash") or "",
                "duration": candidate["duration_ms"],
                "man": "yes",
            },
        )
        choices = found.get("candidates") or found.get("data", {}).get("candidates") or []
        if not choices:
            raise PluginError("source_plugin_no_lyrics")
        lyric = choices[0]
        data = bridge(
            context,
            "/lyric",
            {"id": lyric["id"], "accesskey": lyric["accesskey"], "fmt": "krc", "decode": "true"},
        )
        return {
            "format": "krc",
            "original": data.get("decodeContent", ""),
            "lyric_id": str(lyric["id"]),
        }
