from collections import Counter

from wildstring.main import create_app


def test_openapi_operation_ids_are_unique(settings):
    paths = create_app(settings).openapi()["paths"]
    counts = Counter(
        operation["operationId"]
        for methods in paths.values()
        for operation in methods.values()
        if "operationId" in operation
    )
    assert counts
    assert not {key: count for key, count in counts.items() if count > 1}
    for path in (
        "/api/v1/tracks/{track_id}/stream",
        "/api/v1/podcasts/episodes/{episode_id}/stream",
        "/api/v1/books/{book_id}/ebook/download",
        "/api/v1/books/{book_id}/audiobook/files/{file_index}/stream",
    ):
        assert {"get", "head"} <= paths[path].keys()
