"""Check tracked and new files, including before the first project commit."""

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    result = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    files = sorted(
        {
            name.decode()
            for name in result.stdout.split(b"\0")
            if name and (ROOT / name.decode()).is_file()
        }
    )
    if not files:
        print("No project files to check")
        return 0
    return subprocess.run(
        ["pre-commit", "run", "--show-diff-on-failure", "--files", *files],
        cwd=ROOT,
        check=False,
    ).returncode


if __name__ == "__main__":
    raise SystemExit(main())
