"""Tests for artist catalog gap audit feature."""

from wildstring.config import Settings


def test_catalog_gaps_api(settings: Settings, authenticated_client):
    with authenticated_client(settings) as client:
        # Test audit for 许嵩
        res = client.post(
            "/api/v1/ai/catalog-gaps",
            json={"artist": "许嵩", "limit": 10},
        )
        assert res.status_code == 200
        data = res.json()
        assert data["artist"] == "许嵩"
        assert data["total_target"] == 10
        assert data["total_target"] == data["matched_count"] + data["missing_count"]
        assert 0 <= data["coverage_percent"] <= 100
        assert len(data["missing"]) > 0 or len(data["matched"]) > 0
        assert "许嵩" in data["summary"]
