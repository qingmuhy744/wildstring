"""WildString music backend."""

from importlib.metadata import PackageNotFoundError, version


def get_app_version() -> str:
    try:
        return version("wildstring-backend")
    except (PackageNotFoundError, Exception):
        return "0.7.1"


__version__ = get_app_version()
