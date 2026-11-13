"""Generate the Homebrew Cask definition for WildString macOS releases."""

from __future__ import annotations

import argparse
import re
from pathlib import Path

DEFAULT_REPO = "qingmuhy744/wildstring"
DEFAULT_ASSET = "WildString-macOS.dmg"
_VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def parse_dmg_sha256(checksums_text: str, asset_name: str = DEFAULT_ASSET) -> str:
    """Extract the SHA-256 hex digest for the macOS DMG from a SHA256SUMS file."""
    for raw_line in checksums_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        digest, filename = parts[0].lower(), parts[-1].lstrip("*")
        if filename == asset_name or Path(filename).name == asset_name:
            if _SHA256_RE.fullmatch(digest) is None:
                raise ValueError(f"Invalid SHA-256 digest for {asset_name}: {digest}")
            return digest
    raise ValueError(f"Asset {asset_name} not found in checksums")


def render_cask(version: str, sha256: str, repo: str = DEFAULT_REPO) -> str:
    """Render a Homebrew Cask Ruby definition for a stable WildString macOS release."""
    normalized_version = version.removeprefix("v")
    if _VERSION_RE.fullmatch(normalized_version) is None:
        raise ValueError(f"Homebrew Cask expects a stable X.Y.Z version, got: {version!r}")
    normalized_sha = sha256.strip().lower()
    if _SHA256_RE.fullmatch(normalized_sha) is None:
        raise ValueError(f"Expected 64-char hex SHA-256 digest, got: {sha256!r}")

    return f'''cask "wildstring" do
  version "{normalized_version}"
  sha256 "{normalized_sha}"

  url "https://github.com/{repo}/releases/download/v#{{version}}/{DEFAULT_ASSET}"
  name "WildString"
  name "野弦"
  desc "AI-native self-hosted private music and podcast player"
  homepage "https://github.com/{repo}"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :sonoma"

  app "WildString.app"

  postflight do
    system_command "/usr/bin/xattr",
                   args:         ["-dr", "com.apple.quarantine", "#{{appdir}}/WildString.app"],
                   must_succeed: false
  end

  zap trash: [
    "~/Library/Application Support/WildString",
    "~/Library/Preferences/com.wildstring.mac.plist",
    "~/Library/Caches/com.wildstring.mac",
  ]
end
'''


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True, help="Release version (X.Y.Z or vX.Y.Z)")
    digest_group = parser.add_mutually_exclusive_group(required=True)
    digest_group.add_argument("--sha256", help="SHA-256 hex digest of WildString-macOS.dmg")
    digest_group.add_argument(
        "--checksums-file",
        type=Path,
        help="Path to SHA256SUMS file containing WildString-macOS.dmg",
    )
    parser.add_argument("--repo", default=DEFAULT_REPO, help="GitHub owner/repo")
    parser.add_argument(
        "--output",
        type=Path,
        help="Destination path for Casks/wildstring.rb (prints to stdout when omitted)",
    )
    args = parser.parse_args(argv)

    sha256 = (
        args.sha256
        if args.sha256 is not None
        else parse_dmg_sha256(args.checksums_file.read_text(encoding="utf-8"))
    )
    rendered = render_cask(version=args.version, sha256=sha256, repo=args.repo)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")


if __name__ == "__main__":
    main()
