"""Start the local API from the repository root."""

import uvicorn

from wildstring.config import Settings
from wildstring.request_privacy import install_callback_filter


def main() -> None:
    install_callback_filter()
    settings = Settings()
    uvicorn.run(
        "wildstring.main:create_app",
        factory=True,
        proxy_headers=False,
        host=settings.host,
        port=settings.port,
        reload=settings.environment == "development",
        reload_dirs=["backend/src"] if settings.environment == "development" else None,
        # 与部署镜像一致：75 秒连接保活，客户端心跳与首次播放可复用温热连接
        timeout_keep_alive=75,
    )


if __name__ == "__main__":
    main()
