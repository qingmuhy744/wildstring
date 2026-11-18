#!/usr/bin/env bash
# Install Playwright Chromium and its Ubuntu libraries using cached browser
# binaries (~/.cache/ms-playwright) and cached .deb archives (~/.cache/apt-archives),
# relying solely on apt-get so incompatible .deb files are never force-unpacked.
set -euo pipefail

CACHE_DIR="${APT_ARCHIVE_CACHE:-$HOME/.cache/apt-archives}"

save_cache() {
  mkdir -p "$CACHE_DIR"
  sudo cp -n /var/cache/apt/archives/*.deb "$CACHE_DIR"/ 2>/dev/null || true
}

have_deps() {
  npm --prefix frontend/web exec -- playwright install-deps --dry-run chromium >/dev/null 2>&1
}

if [ -f /etc/apt/apt-mirrors.txt ]; then
  for mirror in https://mirrors.edge.kernel.org/ubuntu https://mirror.math.princeton.edu/pub/ubuntu https://mirrors.mit.edu/ubuntu; do
    grep -qxF "$mirror" /etc/apt/apt-mirrors.txt || echo "$mirror" | sudo tee -a /etc/apt/apt-mirrors.txt >/dev/null
  done
fi

npm --prefix frontend/web exec -- playwright install chromium

if have_deps; then
  echo "Playwright Chromium system dependencies already satisfied; skipping apt."
  exit 0
fi

sudo systemctl stop apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service 2>/dev/null || true

if compgen -G "$CACHE_DIR/*.deb" >/dev/null; then
  sudo cp -n "$CACHE_DIR"/*.deb /var/cache/apt/archives/ 2>/dev/null || true
  mapfile -t missing < <(
    npm --prefix frontend/web exec -- playwright install-deps --dry-run chromium 2>/dev/null \
      | sed -n 's/^  \([a-z0-9][a-z0-9.+:-]*\)$/\1/p'
  )
  if [ "${#missing[@]}" -gt 0 ] \
    && sudo apt-get install -y --no-install-recommends --no-download "${missing[@]}" \
    && have_deps; then
    echo "Installed Playwright Chromium dependencies offline from cached .deb archives."
    save_cache
    exit 0
  fi
  echo "Offline Playwright dependency install was incomplete; falling back to network apt."
fi

for delay in 0 10 30 60; do
  if [ "$delay" -gt 0 ]; then
    echo "Playwright apt attempt failed; retrying in ${delay}s."
    sleep "$delay"
  fi
  if sudo apt-get update -o Acquire::Retries=3 -o Acquire::http::Timeout=20 --error-on=any \
    && npm --prefix frontend/web exec -- playwright install-deps chromium \
    && have_deps; then
    save_cache
    exit 0
  fi
done

echo "Could not install Playwright Chromium system dependencies after retries." >&2
exit 1
