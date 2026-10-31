#!/bin/bash
# Build output is expected at artifacts/macos-derived. Signing and notarization
# run only when the corresponding environment variables are present.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DERIVED="${MACOS_DERIVED_DATA:-$ROOT/artifacts/macos-derived}"
OUT="${MACOS_DMG_PATH:-$ROOT/artifacts/WildString-macOS.dmg}"
APP="$(find "$DERIVED/Build/Products" -type d -name '*.app' -print -quit)"

if [[ -z "$APP" || ! -d "$APP" ]]; then
  echo "No .app found under $DERIVED/Build/Products" >&2
  exit 1
fi

if [[ -n "${APPLE_CERTIFICATE_P12_BASE64:-}" && -n "${APPLE_CERTIFICATE_PASSWORD:-}" && -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  KEYCHAIN="$RUNNER_TEMP/wildstring-macos.keychain"
  P12="$RUNNER_TEMP/wildstring-developer-id.p12"
  if [[ -z "${RUNNER_TEMP:-}" ]]; then
    KEYCHAIN="$(mktemp -d)/wildstring-macos.keychain"
    P12="$(mktemp -d)/wildstring-developer-id.p12"
  fi
  printf '%s' "$APPLE_CERTIFICATE_P12_BASE64" | base64 -D > "$P12"
  security create-keychain -p wildstring "$KEYCHAIN"
  security default-keychain -s "$KEYCHAIN"
  security unlock-keychain -p wildstring "$KEYCHAIN"
  security import "$P12" -k "$KEYCHAIN" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k wildstring "$KEYCHAIN" >/dev/null
  codesign --force --deep --options runtime --sign "$APPLE_SIGNING_IDENTITY" "$APP"
  rm -f "$P12"
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$(dirname "$OUT")"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$OUT"
hdiutil create -volname "野弦" -srcfolder "$STAGE" -ov -format UDZO "$OUT"

if [[ -n "${APPLE_NOTARY_APPLE_ID:-}" && -n "${APPLE_NOTARY_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  xcrun notarytool submit "$OUT" \
    --apple-id "$APPLE_NOTARY_APPLE_ID" \
    --password "$APPLE_NOTARY_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait
  xcrun stapler staple "$OUT"
else
  echo "DMG is not notarized. Without a paid Apple Developer ID, macOS asks the user to open it from the context menu or System Settings."
fi

echo "Wrote $OUT"
