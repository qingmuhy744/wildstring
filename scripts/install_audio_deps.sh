#!/usr/bin/env bash
# Install the audio tools CI needs (ffmpeg, fpcalc) without depending on a
# single apt-get update succeeding: skip when present, install offline from
# the cached .deb archives when possible, and retry the network path.
set -euo pipefail

CACHE_DIR="${APT_ARCHIVE_CACHE:-$HOME/.cache/apt-archives}"
PACKAGES=(ffmpeg libchromaprint-tools)

have_tools() { command -v ffmpeg >/dev/null 2>&1 && command -v fpcalc >/dev/null 2>&1; }

save_cache() {
  mkdir -p "$CACHE_DIR"
  sudo cp -n /var/cache/apt/archives/*.deb "$CACHE_DIR"/ 2>/dev/null || true
}

# Canonical's archive can be unreachable; add fallback mirrors after the
# runner's official entry so apt's mirror+file method tries them in order.
# Done before any early exit so later apt users in the job (e.g. Playwright
# --with-deps) benefit too.
if [ -f /etc/apt/apt-mirrors.txt ]; then
  printf '%s\n' https://mirrors.edge.kernel.org/ubuntu https://mirror.math.princeton.edu/pub/ubuntu https://mirrors.mit.edu/ubuntu | sudo tee -a /etc/apt/apt-mirrors.txt >/dev/null
fi

if have_tools; then
  echo "ffmpeg and fpcalc already available; skipping apt."
  exit 0
fi

sudo systemctl stop apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service 2>/dev/null || true

if compgen -G "$CACHE_DIR/*.deb" >/dev/null; then
  sudo cp -n "$CACHE_DIR"/*.deb /var/cache/apt/archives/ 2>/dev/null || true
  if sudo apt-get install -y --no-install-recommends --no-download "${PACKAGES[@]}" && have_tools; then
    echo "Installed audio tools offline from the apt archive cache."
    save_cache
    exit 0
  fi
  # The image's package lists may not match the cached versions; dpkg needs no lists.
  if sudo dpkg -i --skip-same-version "$CACHE_DIR"/*.deb && have_tools; then
    echo "Installed audio tools from the cached .deb archives with dpkg."
    exit 0
  fi
  echo "Offline install from cache was incomplete; falling back to the network."
fi

for delay in 0 10 30 60; do
  if [ "$delay" -gt 0 ]; then
    echo "apt attempt failed; retrying in ${delay}s."
    sleep "$delay"
  fi
  if sudo apt-get update -o Acquire::Retries=3 -o Acquire::http::Timeout=20 --error-on=any \
    && sudo apt-get install -y --no-install-recommends "${PACKAGES[@]}" \
    && have_tools; then
    save_cache
    exit 0
  fi
done

echo "Could not install ${PACKAGES[*]} after retries." >&2
exit 1
