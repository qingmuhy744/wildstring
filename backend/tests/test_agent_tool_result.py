"""Oversized tool payloads stay usable instead of looking like a failed search."""

from wildstring.agent_ai import fit_tool_result
from wildstring.agent_common import encoded


def test_search_page_keeps_a_prefix_when_the_payload_is_too_long():
    items = [
        {"id": f"track-{index}", "title": "自定义" * 40, "artists": ["许嵩"], "album": "寻雾启示"}
        for index in range(100)
    ]
    fitted = fit_tool_result({"items": items, "total": 240, "limit": 100, "offset": 0}, limit=8000)

    assert fitted["truncated"] is True
    assert fitted["total"] == 240
    assert 0 < fitted["returned"] < 100
    assert fitted["items"]
    assert "查询成功" in fitted["summary"]
    assert len(encoded(fitted)) <= 8000


def test_small_tool_result_is_unchanged():
    result = {"items": [{"id": "one", "title": "浅唱"}], "total": 1}
    assert fit_tool_result(result) is result
