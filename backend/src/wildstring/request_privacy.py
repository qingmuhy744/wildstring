"""Callback privacy for both the Python and Uvicorn/Docker entrypoints."""

import logging


class RedactLastfmCallback(logging.Filter):
    def filter(self, record):
        if isinstance(record.args, tuple) and len(record.args) == 5:
            values = list(record.args)
            if str(values[2]).partition("?")[0].rstrip("/") == "/api/v1/lastfm/callback":
                values[2] = "/api/v1/lastfm/callback"
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
        if scope["type"] != "http" or scope["path"].rstrip("/") != "/api/v1/lastfm/callback":
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
