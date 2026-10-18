"""Timed language layers reach clients without positional guesses or data loss."""

import copy
import json
import sqlite3

from wildstring.library.online_lyrics import display_lyrics, selected_lyrics


def sample():
    return {
        "kind": "synced",
        "source": "fixture",
        "lines": [
            {
                "time_ms": 1000,
                "end_ms": 1800,
                "text": "Synthetic line",
                "words": [{"text": "Synthetic line", "start_ms": 1000, "end_ms": 1800}],
            },
            {"time_ms": 3000, "text": "Another line"},
            {"time_ms": 10000, "text": "After instrumental"},
        ],
        "layers": {
            "translation": [
                {"time_ms": 1010, "text": "合成译文"},
                {"time_ms": 1010, "text": "合成译文"},
                {"time_ms": 1500, "text": "未对齐的时间不硬塞给前一句"},
                {"time_ms": 3000, "text": "另一句译文"},
                {"time_ms": None, "text": "没有时间不能按数组下标拼接"},
            ],
            "romanization": [{"time_ms": 1000, "text": "he cheng"}],
        },
    }


def test_language_alignment_uses_time_and_preserves_words_and_original_layers():
    original = sample()
    snapshot = copy.deepcopy(original)
    visible = display_lyrics(original)
    assert visible["lines"][0]["translation"] == "合成译文"
    assert visible["lines"][0]["romanization"] == "he cheng"
    assert visible["lines"][1]["translation"] == "另一句译文"
    assert "translation" not in visible["lines"][2]
    assert visible["lines"][0]["words"] == original["lines"][0]["words"]
    assert original == snapshot


def test_selected_lyrics_shift_all_languages_once_without_rewriting_candidate():
    original = sample()
    original["layers"]["romanization"][0] |= {
        "end_ms": 1800,
        "words": [{"text": "he cheng", "start_ms": 1000, "end_ms": 1800}],
    }
    encoded = json.dumps(original)
    with sqlite3.connect(":memory:") as db:
        db.row_factory = sqlite3.Row
        db.execute(
            "CREATE TABLE lyric_candidates(id,normalized,source_id,source_url,plugin_id,created_at)"
        )
        db.execute(
            "INSERT INTO lyric_candidates VALUES ('candidate',?,'song','https://example.com','fixture',0)",
            (encoded,),
        )
        selected = selected_lyrics(db, json.dumps({"id": "candidate", "offset_ms": 500}))
        assert selected["lines"][0]["time_ms"] == 1500
        assert selected["lines"][0]["words"][0]["start_ms"] == 1500
        assert selected["lines"][0]["translation"] == "合成译文"
        roma = selected["layers"]["romanization"][0]
        assert roma["time_ms"] == 1500 and roma["end_ms"] == 2300
        assert roma["words"][0]["start_ms"] == 1500
        assert db.execute("SELECT normalized FROM lyric_candidates").fetchone()[0] == encoded
        earlier = selected_lyrics(db, json.dumps({"id": "candidate", "offset_ms": -5000}))
        assert [line["time_ms"] for line in earlier["lines"]] == [0, 0, 5000]
        assert [line.get("translation") for line in earlier["lines"]] == [
            "合成译文",
            "另一句译文",
            None,
        ]
        assert earlier["layers"]["romanization"][0]["words"][0]["start_ms"] == 0
        assert db.execute("SELECT normalized FROM lyric_candidates").fetchone()[0] == encoded


def test_extra_or_missing_rows_do_not_shift_following_translation_pairs():
    original = sample()
    original["layers"]["translation"] = [
        {"time_ms": 0, "text": "译者信息"},
        {"time_ms": 1010, "text": "合成译文"},
        {"time_ms": 3000, "text": "另一句译文"},
    ]
    result = display_lyrics(original)
    assert [line.get("translation") for line in result["lines"]] == ["合成译文", "另一句译文", None]
