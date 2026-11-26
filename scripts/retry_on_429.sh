#!/usr/bin/env bash
set -o pipefail

if (( $# == 0 )); then
  printf 'Usage: %s command [args...]\n' "$0" >&2
  exit 2
fi

log=$(mktemp) || exit "$?"
trap 'rm -f -- "$log"' EXIT

for delay in 0 30 60; do
  if (( delay > 0 )); then
    sleep "$delay"
  fi
  if "$@" 2>&1 | tee "$log"; then
    exit 0
  else
    statuses=("${PIPESTATUS[@]}")
  fi
  status=${statuses[0]}
  if (( status == 0 )); then
    exit "${statuses[1]}"
  fi
  if ! grep -Fq -e 'Received status code 429 from server' -e 'could not resolve plugin artifact' "$log"; then
    exit "$status"
  fi
done
exit "$status"
