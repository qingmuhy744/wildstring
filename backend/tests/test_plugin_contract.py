"""Malformed extensions stop at the contract boundary; codecs ship in plugin packages."""

import importlib.util
from pathlib import Path

import pytest
from fastapi import HTTPException
from test_source_plugins import MANIFEST, package

from wildstring.library.online_lyrics import normalize_bundle
from wildstring.plugin_archives import inspect_package


def test_archive_rejects_file_directory_collisions_and_invalid_manifest():
    for extra, manifest in [
        ({"lib": "file", "lib/module.py": "child"}, None),
        ({"C:/escape.py": "bad"}, None),
        ({"Adapter.py": "case collision"}, None),
        ({"sub//alias.py": "bad"}, None),
        ({}, MANIFEST | {"api_version": True}),
        ({}, MANIFEST | {"upstream": "javascript:alert(1)"}),
        (
            {},
            MANIFEST
            | {"settings": [{"key": "secret", "label": "x", "type": "secret", "required": "true"}]},
        ),
    ]:
        with pytest.raises(HTTPException):
            inspect_package(package(extra, manifest))


@pytest.mark.parametrize(
    "line,layers",
    [
        ({"time_ms": None, "text": "missing time"}, {}),
        ({"time_ms": 0, "end_ms": "bad", "text": "bad end"}, {}),
        ({"time_ms": 0, "text": "bad word", "words": [None]}, {}),
        ({"time_ms": 0, "text": "bad layer"}, {"translation": [{"time_ms": -1, "text": "bad"}]}),
    ],
)
def test_malformed_normalized_lyrics_do_not_reach_playback(line, layers):
    with pytest.raises(ValueError):
        normalize_bundle(
            {"normalized": {"kind": "synced", "lines": [line], "layers": layers}}, "fixture"
        )


def test_packaged_word_codecs_and_language_layers(tmp_path):
    # Load exactly the codec source that is included in every plugin ZIP, not a core copy.
    source = Path(__file__).resolve().parents[2] / "plugins/lyric_formats.py"
    spec = importlib.util.spec_from_file_location("plugin_formats", source)
    codec = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(codec)
    examples = {
        "qrc": '<Lyric_1 LyricContent="[1000,2000]摇(1000,500)滚(1500,1500)"/>',
        "krc": "[1000,2000]<0,500,0>摇<500,1500,0>滚",
        "yrc": "[1000,2000](1000,500,0)摇(1500,1500,0)滚",
    }
    for format_name, original in examples.items():
        result = codec.normalize_bundle(
            {
                "format": format_name,
                "original": original,
                "translation": "[00:01]Rock",
                "romanization": "[00:01]yao gun",
            },
            "fixture",
        )
        checked = normalize_bundle({"normalized": result}, "fixture")
        assert checked["lines"][0]["text"] == "摇滚"
        assert checked["lines"][0]["words"][1] == {"start_ms": 1500, "end_ms": 3000, "text": "滚"}
        assert checked["layers"]["translation"][0]["text"] == "Rock"
