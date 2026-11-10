#!/usr/bin/env bash
# Start, restart or stop the disposable synthetic API used by the Android instrumented suite.
# The suite mutates the synthetic library (reads, playlists, favorites), so retries restart it
# to begin from the same fresh state as the first attempt.
set -euo pipefail

action=${1:?usage: ci_synthetic_api.sh start|restart|stop [log-file]}
log=${2:-artifacts/android-synthetic-api.log}
pidfile="${RUNNER_TEMP:-/tmp}/wildstring-synthetic-api.pid"

stop() {
  if test -f "$pidfile"; then
    kill "$(cat "$pidfile")" || true
    rm -f "$pidfile"
    sleep 2
  fi
}

start() {
  mkdir -p "$(dirname "$log")"
  WILDSTRING_WEB_TEST_PORT=19882 WILDSTRING_TEST_LARGE_LIBRARY=1 WILDSTRING_TEST_API_ONLY=1 \
    uv run --frozen --project backend python scripts/serve_web_tests.py >"$log" 2>&1 &
  echo $! >"$pidfile"
  for _ in $(seq 1 60); do
    if curl --fail --silent http://127.0.0.1:19882/health/ready >/dev/null; then return 0; fi
    sleep 1
  done
  cat "$log"
  return 1
}

case "$action" in
  start) start ;;
  restart) stop; start ;;
  stop) stop ;;
  *) echo "unknown action: $action" >&2; exit 2 ;;
esac
