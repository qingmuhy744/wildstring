"""Built-in adapter summaries and batched detail requests use synthetic responses."""

import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "community_adapters", Path(__file__).resolve().parents[2] / "plugins/community_adapters.py"
)
adapters = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapters)


def test_qq_gather_combines_song_requests_and_propagates_failure(tmp_path):
    class Context:
        directory = tmp_path
        requests = []

        def http(self, url, **kwargs):
            self.requests.append(kwargs["payload"])
            raise adapters.PluginError("source_plugin_rate_limited", upstream_429=True)

    context = Context()
    with pytest.raises(adapters.PluginError) as error:
        adapters.QQPlugin().call(context, "song", ["first", "second"])
    assert error.value.upstream_429
    assert len(context.requests) == 1
    assert [context.requests[0][key]["param"]["song_mid"] for key in ("req_0", "req_1")] == [
        "first",
        "second",
    ]


def test_qq_metadata_batches_and_deduplicates_albums(monkeypatch):
    plugin = adapters.QQPlugin()
    calls = []
    candidates = [
        {"id": identity, "source_url": "https://example.com/song"} for identity in ("a", "b", "c")
    ]

    def call(context, operation, value):
        calls.append((operation, value))
        if operation == "song":
            return [
                {
                    "track": {
                        "mid": "a",
                        "title": "A",
                        "singer": [{"name": "Artist"}],
                        "interval": 10,
                        "album": {"mid": "release"},
                    }
                },
                None,
                {
                    "track": {
                        "mid": "c",
                        "title": "C",
                        "singer": [{"name": "Artist"}],
                        "interval": 12,
                        "album": {"mid": "release"},
                    }
                },
            ]
        return [{"album": {"name": "Album", "time_public": "2020-01-01"}}]

    monkeypatch.setattr(plugin, "call", call)
    shallow = plugin.metadata(None, {"candidates": candidates, "include_release": False})
    assert [item["id"] for item in shallow] == ["a", "c"]
    assert calls == [("song", ["a", "b", "c"])]
    calls.clear()
    full = plugin.metadata(None, {"candidates": candidates, "include_release": True})
    assert calls == [("song", ["a", "b", "c"]), ("album", ["release"])]
    assert all(item["fields"]["release_date"] == "2020-01-01" for item in full)


def test_netease_summary_and_batched_metadata(monkeypatch):
    calls = []
    songs = [
        {
            "id": 2,
            "name": "<b>Second</b>",
            "ar": [{"name": "Artist"}],
            "dt": 2000,
            "al": {"id": 7, "name": "Album"},
        },
        {
            "id": 1,
            "name": "First",
            "ar": [{"name": "Artist"}],
            "dt": 1000,
            "al": {"id": 7, "name": "Album"},
        },
    ]

    def bridge(context, path, params):
        calls.append((path, params))
        if path == "/cloudsearch":
            return {"result": {"songs": songs}}
        if path == "/song/detail":
            return {"songs": songs}
        return {
            "album": {
                "name": "Album",
                "publishTime": 1577836800000,
                "picUrl": "https://p.music.126.net/a",
            }
        }

    monkeypatch.setattr(adapters, "bridge", bridge)
    plugin = adapters.NeteasePlugin()
    candidates = plugin.search(None, "query")
    assert candidates[0]["title"] == "Second" and candidates[0]["duration_ms"] == 2000
    calls.clear()
    result = plugin.metadata(
        None, {"candidates": candidates + [{"id": "missing"}], "include_release": False}
    )
    assert [item["id"] for item in result] == ["2", "1"]
    assert calls == [("/song/detail", {"ids": "2,1,missing"})]
    calls.clear()
    result = plugin.metadata(None, {"candidates": candidates, "include_release": True})
    assert [path for path, _ in calls] == ["/song/detail", "/album"]
    assert result[0]["fields"]["release_date"] == "2020-01-01"


def test_kugou_batch_aligns_reordered_results_and_lyrics_hash(monkeypatch):
    calls = []

    def bridge(context, path, params):
        calls.append((path, params))
        if path == "/search":
            return {
                "data": {
                    "lists": [
                        {
                            "MixSongID": 1,
                            "SongName": "First",
                            "SingerName": "Artist",
                            "Duration": 5,
                            "FileHash": "hash1",
                        },
                        {
                            "MixSongID": 2,
                            "SongName": "Second",
                            "SingerName": "Artist",
                            "Duration": 6,
                            "FileHash": "hash2",
                        },
                    ]
                }
            }
        if path == "/krm/audio":
            return {
                "data": [
                    {
                        "entity_id": 2,
                        "base": {"audio_name": "Second detail"},
                        "album_info": {
                            "album_name": "Album",
                            "sizable_cover": "https://img.kugou.com/{size}/cover",
                        },
                    },
                    {
                        "entity_id": 1,
                        "base": {"audio_name": "First detail"},
                        "album_info": {"album_name": "Album"},
                    },
                ]
            }
        if path == "/search/lyric":
            return {"candidates": [{"id": 99, "accesskey": "key"}]}
        return {"decodeContent": "words"}

    monkeypatch.setattr(adapters, "bridge", bridge)
    plugin = adapters.KuGouPlugin()
    candidates = plugin.search(None, "query")
    calls.clear()
    result = plugin.metadata(None, {"candidates": candidates, "include_release": True})
    assert [item["id"] for item in result] == ["2", "1"]
    assert result[0]["cover_url"] == "https://img.kugou.com/500/cover"
    assert calls[0][1]["album_audio_id"] == "1,2"
    plugin.lyrics(None, result[0])
    assert calls[1][1]["hash"] == "hash2"


def test_netease_album_failure_keeps_other_details(monkeypatch):
    def bridge(context, path, params):
        if path == "/song/detail":
            return {
                "songs": [
                    {"id": 1, "name": "One", "al": {"id": 10}},
                    {"id": 2, "name": "Two", "al": {"id": 20}},
                ]
            }
        if params["id"] == 10:
            raise adapters.PluginError("source_plugin_unavailable")
        return {"album": {"name": "Release"}}

    monkeypatch.setattr(adapters, "bridge", bridge)
    candidates = [{"id": "1"}, {"id": "2"}]
    details = adapters.NeteasePlugin().metadata(
        None, {"candidates": candidates, "include_release": True}
    )
    assert [item["id"] for item in details] == ["2"]


def test_bridge_preserves_structured_rate_error(monkeypatch, tmp_path):
    from types import SimpleNamespace

    context = SimpleNamespace(
        directory=tmp_path,
        data={"config": {}, "proxy_mode": "environment", "secrets": {}},
    )
    monkeypatch.setattr(
        adapters.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=0,
            stdout=b'{"wildstring_error":"source_plugin_rate_limited","upstream_429":true,"retry_after":12}',
        ),
    )
    with pytest.raises(adapters.PluginError) as error:
        adapters.bridge(context, "/song/detail", {})
    assert error.value.upstream_429 is True
    assert error.value.retry_after == 12
