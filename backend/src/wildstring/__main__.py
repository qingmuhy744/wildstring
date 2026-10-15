"""Start the local API from the repository root."""

import uvicorn

from wildstring.config import Settings


def main() -> None:
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
