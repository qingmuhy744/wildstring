#!/usr/bin/env bash
set -o pipefail

if (( $# == 0 )); then
  printf 'Usage: %s command [args...]\n' "$0" >&2
  exit 2
fi

log=$(mktemp) || exit "$?"
trap 'rm -f -- "$log"' EXIT

refresh_dependencies=false
show_stacktrace=false
for attempt in 1 2 3; do
  if WILDSTRING_GRADLE_REFRESH_DEPENDENCIES="$refresh_dependencies" \
    WILDSTRING_GRADLE_STACKTRACE="$show_stacktrace" \
    "$@" 2>&1 | tee "$log"; then
    exit 0
  else
    statuses=("${PIPESTATUS[@]}")
  fi
  status=${statuses[0]}
  if (( status == 0 )); then
    exit "${statuses[1]}"
  fi
  if (( attempt == 3 )); then
    break
  fi
  show_stacktrace=true
  if grep -Eiq 'received status code 429 from server|HTTP (status |response code: )?429' "$log"; then
    # Reuse successful resolutions when Maven is already rate limiting requests.
    refresh_dependencies=false
    reason='HTTP 429'
  elif grep -Eiq 'received status code 50[234] from server|HTTP (status |response code: )?50[234]|connection reset|read timed out' "$log"; then
    refresh_dependencies=false
    reason='transient upstream repository error'
  elif grep -Fiq 'could not resolve plugin artifact' "$log"; then
    if [[ $refresh_dependencies == true ]]; then
      refresh_dependencies=false
      reason='Gradle plugin resolution still failing after refresh'
    else
      refresh_dependencies=true
      reason='Gradle plugin resolution failed; refreshing dependency metadata'
    fi
  else
    break
  fi
  delay=$((30 * attempt))
  printf 'Attempt %d/3 failed (%s). Retrying in %ds.\n' "$attempt" "$reason" "$delay" >&2
  sleep "$delay" || exit "$?"
done
exit "$status"
