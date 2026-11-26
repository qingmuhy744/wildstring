"""Callback privacy for both the Python and Uvicorn/Docker entrypoints."""

import logging

REDACTED_PATHS = frozenset(
    {"/api/v1/lastfm/callback", "/oauth/authorize", "/api/v1/remote-storage/callback"}
)


class RedactLastfmCallback(logging.Filter):
    def filter(self, record):
        if isinstance(record.args, tuple) and len(record.args) == 5:
            values = list(record.args)
            base_path = str(values[2]).partition("?")[0].rstrip("/")
            if any(base_path.endswith(path) for path in REDACTED_PATHS):
                values[2] = base_path
                record.args = tuple(values)
        return True


def install_callback_filter():
    logger = logging.getLogger("uvicorn.access")
    if not any(isinstance(item, RedactLastfmCallback) for item in logger.filters):
        logger.addFilter(RedactLastfmCallback())


class CallbackPrivacy:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not any(
            scope["path"].rstrip("/").endswith(path) for path in REDACTED_PATHS
        ):
            await self.app(scope, receive, send)
            return

        async def private_send(message):
            if message["type"] == "http.response.start":
                headers = [
                    (key, value)
                    for key, value in message["headers"]
                    if key.lower() not in {b"cache-control", b"referrer-policy"}
                ]
                message = message | {
                    "headers": headers
                    + [(b"cache-control", b"no-store"), (b"referrer-policy", b"no-referrer")]
                }
            await send(message)

        await self.app(scope, receive, private_send)
