"""Start the local API from the repository root."""

import logging

import uvicorn

from wildstring.config import Settings


class RedactLastfmCallback(logging.Filter):
    def filter(self, record):
        if isinstance(record.args, tuple) and len(record.args) == 5:
            values = list(record.args)
            if str(values[2]).partition("?")[0] == "/api/v1/lastfm/callback":
                values[2] = "/api/v1/lastfm/callback"
                record.args = tuple(values)
        return True


def main() -> None:
    logging.getLogger("uvicorn.access").addFilter(RedactLastfmCallback())
    settings = Settings()
    uvicorn.run(
        "wildstring.main:create_app",
        factory=True,
        host=settings.host,
        port=settings.port,
        reload=settings.environment == "development",
        reload_dirs=["backend/src"] if settings.environment == "development" else None,
    )


if __name__ == "__main__":
    main()
