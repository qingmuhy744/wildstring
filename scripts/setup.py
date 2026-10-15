"""Create local configuration without overwriting user settings."""

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    target = ROOT / ".env"
    if not target.exists():
        shutil.copyfile(ROOT / ".env.example", target)
        target.chmod(0o600)
        print("Created .env from .env.example")
    for name in ("music", "runtime"):
        (ROOT / name).mkdir(exist_ok=True)


if __name__ == "__main__":
    main()
