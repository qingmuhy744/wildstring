"""Synthetic Nuitka module for the real ZIP plugin worker regression."""


class Plugin:
    def search(self, context, query):
        return [{"id": "native-song", "query": query}]

    def metadata(self, context, candidate):
        return {"id": candidate["id"], "fields": {"title": "Compiled fixture"}}

    def lyrics(self, context, candidate):
        return {"format": "lrc", "original": "[00:01]Compiled fixture"}
