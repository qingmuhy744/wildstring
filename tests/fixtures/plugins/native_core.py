"""Synthetic Nuitka module for the real ZIP plugin worker regression."""


class Plugin:
    def search(self, context, query):
        return [
            {
                "id": "native-song",
                "title": "Compiled fixture",
                "artists": ["Fixture"],
                "duration_ms": 1000,
                "source_url": "https://example.com/native-song",
            }
        ]

    def metadata(self, context, request):
        return [
            {**candidate, "fields": {"title": "Compiled fixture"}}
            for candidate in request["candidates"]
        ]

    def lyrics(self, context, candidate):
        return {"format": "lrc", "original": "[00:01]Compiled fixture"}
