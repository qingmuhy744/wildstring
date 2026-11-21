"""Adapters for community projects; these are not official music-platform APIs.

QQMusicApi is a pinned runtime dependency. KuGouMusicApi and
NeteaseCloudMusicApiEnhanced modules ship in the ZIP; external services are optional.
"""

import asyncio
import importlib.util
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlencode, urlsplit

from wildstring.plugin_api import Manifest, PluginError

BRIDGE_SETTINGS = (
    {
        "key": "base_url",
        "label": "外部服务地址（可选，留空使用插件内置）",
        "type": "url",
    },
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
    proxy = context.data.get("proxy_url") if mode in {"manual", "custom"} else None
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
                "rate": context.data.get("rate"),
                "rate_command": [sys.executable, "-I", "-m", "wildstring.plugin_rate"],
            }
        ).encode(),
        capture_output=True,
        timeout=max(35, (context.data.get("rate") or {}).get("interval_seconds", 5) * 6 + 25)
        if (context.data.get("rate") or {}).get("batch_id")
        else 35,
        check=False,
        cwd=context.directory,
        env=environment,
    )
    if result.returncode or len(result.stdout) > 2 * 1024 * 1024:
        raise PluginError("source_plugin_worker_failed")
    try:
        value = json.loads(result.stdout)
        if isinstance(value, dict) and value.get("wildstring_error"):
            code = value["wildstring_error"]
            raise PluginError(
                code
                if code
                in {
                    "lyric_scan_paused",
                    "source_plugin_rate_limited",
                    "source_plugin_auth_or_rejected",
                    "source_plugin_timeout",
                }
                else "source_plugin_unavailable",
                upstream_429=value.get("upstream_429", False),
                retry_after=value.get("retry_after"),
                cooldown_until=value.get("cooldown_until"),
            )
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
            self.context.http,
            url,
            payload=payload,
            headers=options.get("headers"),
            rate_codes=(429, 2001),
        )
        if any(
            isinstance(item, dict) and item.get("code") in (429, 2001)
            for key, item in result.items()
            if key.startswith("req_")
        ):
            raise PluginError("source_plugin_rate_limited", upstream_429=True, retry_after=900)

        class Response:
            status_code = 200
            content = json.dumps(result).encode()
            text = content.decode()

            def __init__(self):
                self.cookies = {}
                self.headers = {}

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
        version="2.0.0",
        request_pacing=True,
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
                elif operation in {"song", "album"}:
                    api = client.song if operation == "song" else client.album
                    responses = await client.gather(
                        [api.get_detail(identity) for identity in value],
                        return_exceptions=True,
                    )
                    if responses and all(isinstance(r, Exception) for r in responses):
                        raise responses[0]
                    return [
                        r.model_dump(mode="json") if not isinstance(r, Exception) else None
                        for r in responses
                    ]
                else:
                    response = await client.lyric.get_lyric(value, qrc=True, trans=True, roma=True)
                return response.model_dump(mode="json")

        return asyncio.run(asyncio.wait_for(run(), timeout=35))

    def search(self, context, query):
        songs = self.call(context, "search", query).get("song", [])[:3]
        return [
            {
                "id": song["mid"],
                "title": clean(song.get("title") or song.get("name")),
                "artists": [clean(a.get("name")) for a in song.get("singer", [])],
                "album": clean((song.get("album") or {}).get("name")),
                "duration_ms": int(song.get("interval") or 0) * 1000 or None,
                "release_id": (song.get("album") or {}).get("mid"),
                "source_url": f"https://y.qq.com/n/ryqq/songDetail/{song['mid']}",
            }
            for song in songs
            if song.get("mid")
        ]

    def metadata(self, context, request):
        candidates = request["candidates"]
        songs = self.call(context, "song", [item["id"] for item in candidates])
        tracks = [
            (item, result["track"])
            for item, result in zip(candidates, songs, strict=False)
            if result and result.get("track")
        ]
        mids = list(
            dict.fromkeys(
                (song.get("album") or {}).get("mid")
                for _, song in tracks
                if (song.get("album") or {}).get("mid")
            )
        )
        releases = {}
        if request["include_release"] and mids:
            releases = dict(zip(mids, self.call(context, "album", mids), strict=False))
        output = []
        for candidate, song in tracks:
            album = song.get("album") or {}
            mid = album.get("mid")
            details = releases.get(mid) or {}
            release = details.get("album") or album
            fields = {
                "title": clean(song.get("title") or song.get("name")),
                "artists": [clean(a.get("name")) for a in song.get("singer", [])],
                "album": clean(release.get("name") or album.get("name")),
            }
            if request["include_release"] and release.get("time_public"):
                fields["release_date"] = release["time_public"]
            if request["include_release"] and release.get("genre"):
                fields["genres"] = [clean(release["genre"])]
            for field, key in (
                ("track_number", "index_album"),
                ("disc_number", "index_cd"),
            ):
                if positive(song.get(key)):
                    fields[field] = positive(song[key])
            output.append(
                {
                    **candidate,
                    "id": candidate["id"],
                    "release_id": mid,
                    "title": fields["title"],
                    "artists": fields["artists"],
                    "duration_ms": int(song.get("interval") or 0) * 1000 or None,
                    "fields": fields,
                    "cover_url": f"https://y.gtimg.cn/music/photo_new/T002R500x500M000{mid}.jpg"
                    if request["include_release"] and mid
                    else None,
                    "raw": {"song": song, "album": details},
                }
            )
        return output

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
        version="2.0.0",
        request_pacing=True,
        settings=BRIDGE_SETTINGS,
        cover_hosts=("music.126.net",),
        requires_programs=("node",),
    )

    def available(self):
        return True

    def search(self, context, query):
        songs = (
            bridge(context, "/cloudsearch", {"keywords": query, "type": 1, "limit": 3})
            .get("result", {})
            .get("songs", [])[:3]
        )
        return [
            {
                "id": str(song["id"]),
                "title": clean(song.get("name")),
                "artists": [
                    clean(a.get("name")) for a in (song.get("ar") or song.get("artists") or [])
                ],
                "album": clean((song.get("al") or song.get("album") or {}).get("name")),
                "duration_ms": int(song.get("dt") or song.get("duration") or 0) or None,
                "release_id": str((song.get("al") or song.get("album") or {}).get("id") or ""),
                "source_url": f"https://music.163.com/song?id={song['id']}",
            }
            for song in songs
            if song.get("id")
        ]

    def metadata(self, context, request):
        candidates = {item["id"]: item for item in request["candidates"]}
        result = bridge(context, "/song/detail", {"ids": ",".join(candidates)})
        songs = [song for song in result.get("songs", []) if str(song.get("id")) in candidates]
        albums = {}
        if request["include_release"]:
            for song in songs:
                album = song.get("al") or song.get("album") or {}
                identity = album.get("id")
                if identity and identity not in albums:
                    try:
                        albums[identity] = bridge(context, "/album", {"id": identity}).get("album")
                    except PluginError as error:
                        if error.code in {
                            "source_plugin_rate_limited",
                            "lyric_scan_paused",
                        }:
                            raise
                        albums[identity] = None
        output = []
        for song in songs:
            album = song.get("al") or song.get("album") or {}
            if request["include_release"] and album.get("id") and not albums.get(album["id"]):
                continue
            details = albums.get(album.get("id")) or album
            fields = {
                "title": clean(song.get("name")),
                "artists": [
                    clean(a.get("name")) for a in (song.get("ar") or song.get("artists") or [])
                ],
                "album": clean(details.get("name")),
            }
            if request["include_release"] and details.get("publishTime", 0) > 0:
                fields["release_date"] = (
                    datetime.fromtimestamp(details["publishTime"] / 1000, UTC).date().isoformat()
                )
            for field, key in (("track_number", "no"), ("disc_number", "cd")):
                if positive(song.get(key)):
                    fields[field] = positive(song[key])
            identity = str(song["id"])
            output.append(
                {
                    **candidates[identity],
                    "id": identity,
                    "release_id": str(album.get("id") or ""),
                    "title": fields["title"],
                    "artists": fields["artists"],
                    "duration_ms": int(song.get("dt") or song.get("duration") or 0) or None,
                    "fields": fields,
                    "cover_url": details.get("picUrl") if request["include_release"] else None,
                    "raw": {"song": song, "album": details},
                }
            )
        return output

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
        version="2.0.0",
        request_pacing=True,
        settings=BRIDGE_SETTINGS,
        cover_hosts=("kugou.com",),
        requires_programs=("node",),
    )

    def available(self):
        return True

    def search(self, context, query):
        result = bridge(context, "/search", {"keywords": query, "type": "song", "pagesize": 3})
        data = result.get("data") or {}
        songs = (data.get("lists") or data.get("info") or [])[:3]
        output = []
        for song in songs:
            identity = str(
                song.get("MixSongID")
                or song.get("mixsongid")
                or song.get("AlbumAudioID")
                or song.get("album_audio_id")
                or ""
            )
            if not identity:
                continue
            file_hash = song.get("FileHash") or song.get("hash") or ""
            output.append(
                {
                    "id": identity,
                    "title": clean(song.get("SongName") or song.get("FileName")),
                    "artists": [
                        clean(a) for a in str(song.get("SingerName", "")).split("、") if a.strip()
                    ],
                    "album": clean(song.get("AlbumName")),
                    "duration_ms": int(song.get("Duration") or song.get("duration") or 0) * 1000
                    or None,
                    "release_id": str(song.get("AlbumID") or ""),
                    "source_url": f"https://www.kugou.com/song/#hash={file_hash}",
                    "token": {"hash": file_hash},
                }
            )
        return output

    def metadata(self, context, request):
        candidates = {item["id"]: item for item in request["candidates"]}
        data = (
            bridge(
                context,
                "/krm/audio",
                {
                    "album_audio_id": ",".join(candidates),
                    "fields": "album_info,base,authors.base",
                },
            ).get("data")
            or []
        )
        output = []
        for record in data:
            base = record.get("base") or {}
            identity = str(
                record.get("album_audio_id")
                or record.get("entity_id")
                or base.get("album_audio_id")
                or base.get("id")
                or ""
            )
            candidate = candidates.get(identity)
            if not candidate:
                continue
            album = record.get("album_info") or {}
            artists = [
                clean(a.get("base", a).get("author_name") or a.get("base", a).get("name"))
                for a in record.get("authors", [])
            ]
            fields = {
                "title": clean(base.get("audio_name") or candidate["title"]),
                "artists": artists or candidate["artists"],
                "album": clean(album.get("album_name") or candidate.get("album")),
            }
            if request["include_release"] and album.get("publish_date"):
                fields["release_date"] = str(album["publish_date"])[:10]
            file_hash = (candidate.get("token") or {}).get("hash") or base.get("hash") or ""
            output.append(
                {
                    **candidate,
                    "release_id": str(album.get("album_id") or candidate.get("release_id") or ""),
                    "title": fields["title"],
                    "artists": fields["artists"],
                    "duration_ms": int(base.get("duration") or 0) * 1000
                    or candidate.get("duration_ms"),
                    "fields": fields,
                    "token": {"hash": file_hash},
                    "cover_url": (album.get("sizable_cover") or album.get("cover") or "").replace(
                        "{size}", "500"
                    )
                    or None
                    if request["include_release"]
                    else None,
                    "raw": record,
                }
            )
        return output

    def lyrics(self, context, candidate):
        found = bridge(
            context,
            "/search/lyric",
            {
                "keywords": candidate["title"] + " " + " ".join(candidate["artists"]),
                "hash": (candidate.get("token") or {}).get("hash") or "",
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
            {
                "id": lyric["id"],
                "accesskey": lyric["accesskey"],
                "fmt": "krc",
                "decode": "true",
            },
        )
        return {
            "format": "krc",
            "original": data.get("decodeContent", ""),
            "lyric_id": str(lyric["id"]),
        }
