#!/usr/bin/env bash
# Capture WildString screenshots for agents through one entry point.
#
# docs/screenshot-matrix.md is the source of truth. Each row declares a platform, page, state,
# themes, widths, layer and the trigger that produces it. This script only drives the existing
# triggers and copies their files into a clean output directory; it never edits the app or the
# test suites.
#
#   scripts/agent_shot.sh web        deterministic capture through Playwright (quick layer)
#   scripts/agent_shot.sh android    instrumented capture on the connected emulator (quick)
#   scripts/agent_shot.sh macos      in-process NSHostingView renders (quick)
#   scripts/agent_shot.sh ios        no quick trigger yet; prints the manual procedure
#
# `--window` never runs anything: it prints the delivery-time window check (real app, window
# chrome, materials, focus rings, animations) that the user performs manually before a release.
# See "Manual sign-off" at the bottom of this file.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MATRIX="$ROOT/docs/screenshot-matrix.md"

ANDROID_PHONE_AVD="WildString_Pixel_API35"
ANDROID_PAD_AVD="WildString_Tablet_API35"
ANDROID_RAW="$ROOT/artifacts/android-instrumented"
ANDROID_CLASS="PodcastResumeUiTest"

usage() {
  cat <<'USAGE'
Usage: scripts/agent_shot.sh <platform> [--quick|--window] [--state a,b] [--list]

platform: web | android | macos | ios
  --quick    deterministic capture layer (the default; the only layer that runs)
  --window   print the manual window-level sign-off procedure; runs nothing
  --state    only rows whose page, page-state or state matches one of the comma-separated values
  --list     print the matrix rows for the platform and which ones have no quick trigger

Exit status is non-zero when a required (quick) state is missing or a capture step fails.
USAGE
}

print_manual_signoff() {
  cat <<'MANUAL'

# Manual sign-off — run once before delivery, not required by default.
#
# Window chrome, materials, focus rings and real animations change rarely, so the user checks
# them by hand before a release. Nothing below runs automatically.

macOS: launch without stealing focus, resolve the CGWindowID, capture just that window.
  open -g artifacts/macos-derived.noindex/Build/Products/Debug/WildString.app
  # List on-screen windows with their ids; pick the one owned by WildString.
  osascript -l JavaScript -e 'ObjC.import("CoreGraphics"); const l = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID).js; l.map(w => `${w.kCGWindowNumber.js}\t${w.kCGWindowOwnerName.js}\t${w.kCGWindowName.js}`).join("\n")'
  screencapture -x -o -l <id> artifacts/shots/macos/manual.png
  osascript -e 'tell application "WildString" to quit'
  #
  # If the PNG is black or shows the desktop wallpaper, the terminal lacks Screen Recording
  # permission: System Settings → Privacy & Security → Screen Recording, enable the terminal.
  # Over SSH the session cannot see the WindowServer; allow /usr/libexec/sshd-keygen-wrapper
  # and wrap the capture as:
  #   launchctl asuser $(id -u) screencapture -x -o -l <id> artifacts/shots/macos/manual.png
  # Never retry blindly; fix the permission first.

iOS: boot a simulator and screenshot the screen; no TCC permission needed.
  xcrun simctl boot "iPhone 17 Pro"
  open -a Simulator
  xcrun simctl io booted screenshot artifacts/shots/ios/manual.png
  # Naming convention: artifacts/shots/ios/<page>-<state>-<theme>-<width>.png

Android: the same instrumented capture as the quick layer, on one device.
  adb devices                                             # confirm the serial
  ANDROID_SERIAL=<serial> make android-instrumented-test ANDROID_TEST_CLASSES=PodcastResumeUiTest
  # PNGs land in artifacts/android-instrumented/iteration-1/attempt-1/screenshots/<Class>/
  # A one-off full-screen grab instead: adb -s <serial> exec-out screencap -p > out.png

Review the images against DESIGN.md §5 and record which states you saw.
MANUAL
}

if [ $# -eq 0 ]; then
  usage
  print_manual_signoff
  exit 0
fi

case "$1" in
  -h | --help)
    usage
    print_manual_signoff
    exit 0
    ;;
esac

PLATFORM="$1"
shift

LIST=0
WINDOW=0
STATE_FILTER=""

while [ $# -gt 0 ]; do
  case "$1" in
    --quick) ;;
    --window) WINDOW=1 ;;
    --list) LIST=1 ;;
    --state) shift; STATE_FILTER="${1:-}" ;;
    --state=*) STATE_FILTER="${1#--state=}" ;;
    -h | --help) usage; print_manual_signoff; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

case "$PLATFORM" in
  web | android | macos | ios) ;;
  *)
    echo "Unknown platform: $PLATFORM (expected web, android, macos or ios)" >&2
    exit 2
    ;;
esac

if [ "$WINDOW" = "1" ]; then
  print_manual_signoff
  exit 0
fi

OUT="$ROOT/artifacts/shots/$PLATFORM"

# Rows are emitted as platform|page|state|themes|widths|layer|how|shows. The table header and
# separator are skipped; rows for other platforms are dropped.
matrix_rows() {
  awk '
    /^\| platform \|/ { in_table = 1; next }
    /^\| --- / { next }
    in_table && /^\|/ {
      gsub(/^ *\| */, ""); gsub(/ *\| *$/, "")
      n = split($0, f, " *\\| *")
      if (n >= 8) printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", f[1], f[2], f[3], f[4], f[5], f[6], f[7]
      next
    }
    in_table { in_table = 0 }
  ' "$MATRIX" | awk -v want="$PLATFORM" -F'\t' '$1 == want'
}

row_selected() {
  [ -z "$STATE_FILTER" ] && return 0
  local page="$1" state="$2" item
  # A here-string keeps the comma split local to this subshell; assigning IFS here would leak
  # into the caller's tab-separated `read` loop.
  while IFS= read -r item; do
    if [ "$item" = "$page" ] || [ "$item" = "$page-$state" ] || [ "$item" = "$state" ]; then
      return 0
    fi
  done <<EOF
$(printf '%s\n' "$STATE_FILTER" | tr ',' '\n')
EOF
  return 1
}

# Emits <page>-<state>-<theme>-<width>.png for every theme/width of one row.
row_files() {
  local page="$1" state="$2" themes="$3" widths="$4" theme width
  for theme in $(printf '%s' "$themes" | tr ',' ' '); do
    for width in $(printf '%s' "$widths" | tr ',' ' '); do
      printf '%s-%s-%s-%s.png\n' "$page" "$state" "$theme" "$width"
    done
  done
}

if [ "$LIST" = "1" ]; then
  echo "# $PLATFORM rows (docs/screenshot-matrix.md)"
  echo
  while IFS=$'\t' read -r ignored page state themes widths layer how; do
    [ -n "$ignored" ] || continue
    row_selected "$page" "$state" || continue
    printf '  %-6s %-22s %-22s %-10s %-12s %s\n' "$layer" "$page" "$state" "$themes" "$widths" "$how"
  done <<EOF
$(matrix_rows)
EOF
  echo
  echo "Rows without an automated trigger (manual sign-off before delivery):"
  manual="$(matrix_rows | awk -F'\t' '$6 == "manual" { printf "  %-24s %-18s %s\n", $2, $3, $7 }')"
  if [ -n "$manual" ]; then
    echo "$manual"
  else
    echo "  none — every $PLATFORM row has a quick trigger."
  fi
  exit 0
fi

mkdir -p "$ROOT/artifacts/shots"
# Stale files from a previous run (a Phone capture mixed into a Pad run) must never survive.
rm -rf "${OUT:?}"
mkdir -p "$OUT"
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/wildstring-shots.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT

echo "==> $PLATFORM quick layer -> artifacts/shots/$PLATFORM/"

declare -a MISSING=()
declare -a CAPTURED=()

# Page and state are recorded explicitly: names like "podcasts-show" contain dashes, so parsing
# them back out of the file name would guess wrong.
record_shot() {
  local source="$1" target="$2" page="$3" state="$4" theme="$5" width="$6" note="$7"
  if [ -f "$source" ]; then
    cp "$source" "$OUT/$target"
    CAPTURED+=("$target|$page|$state|$theme|$width|$note")
  else
    MISSING+=("$target|$page|$state|$theme|$width|$note|source not produced: ${source#"$ROOT"/}")
  fi
}

# --- web -------------------------------------------------------------------

capture_web() {
  local spec="frontend/web/tests/podcast-progress.spec.ts"
  local only="续听界面桌面与手机浅深主题视觉证据"
  local log="$STAGING/playwright.log" width theme
  echo "Building the Web bundle served by the fixture API"
  (cd "$ROOT" && make build-web >/dev/null)
  echo "Running Playwright: podcast-progress.spec.ts — $only"
  if ! (cd "$ROOT/frontend/web" &&
    WILDSTRING_TEST_PODCAST=1 npx playwright test "$spec" --project=desktop --grep "$only" \
      >"$log" 2>&1); then
    tail -40 "$log" >&2 || true
    echo "Playwright run failed; the log tail is above." >&2
    return 1
  fi
  for width in 1360 390; do
    for theme in light dark; do
      record_shot "$ROOT/artifacts/resume-show-$width-$theme.png" \
        "podcasts-show-normal-$theme-$width.png" \
        podcasts-show normal "$theme" "$width" "节目页：续听中的单集行与进度徽标"
      record_shot "$ROOT/artifacts/resume-dialog-$width-$theme.png" \
        "resume-dialog-ask-$theme-$width.png" \
        resume-dialog ask "$theme" "$width" "续听询问弹窗"
      record_shot "$ROOT/artifacts/resume-conflict-$width-$theme.png" \
        "podcasts-show-conflict-$theme-$width.png" \
        podcasts-show conflict "$theme" "$width" "节目页冲突提示（另一台设备更新了进度）与播放条"
      record_shot "$ROOT/artifacts/resume-settings-$width-$theme.png" \
        "settings-podcast-resume-$theme-$width.png" \
        settings podcast-resume "$theme" "$width" "个人设置：播客单集接续"
      record_shot "$ROOT/artifacts/resume-settings-error-$width-$theme.png" \
        "settings-podcast-resume-error-$theme-$width.png" \
        settings podcast-resume-error "$theme" "$width" "个人设置：保存失败提示"
    done
  done
  return 0
}

# --- android ---------------------------------------------------------------

avd_config() { printf '%s/.android/avd/%s.avd/config.ini' "$HOME" "$1"; }

# AGENTS.md §4: both benchmark AVDs must have hw.keyboard=yes so the computer keyboard works in
# the emulator window. A missing entry is a setup error, not something to work around.
check_avd_keyboard() {
  local avd="$1" config
  config="$(avd_config "$avd")"
  if [ ! -f "$config" ]; then
    echo "AVD $avd not found ($config); create the Phone 1080x1920 / Pad 2560x1600 AVDs per AGENTS.md §4." >&2
    return 1
  fi
  if ! grep -Eq '^hw\.keyboard=yes$' "$config"; then
    echo "AVD $avd is missing hw.keyboard=yes in $config." >&2
    echo "Add hw.keyboard=yes (and hw.keyboard.charmap=qwerty2), then restart the emulator." >&2
    return 1
  fi
}

serial_size() {
  adb -s "$1" shell wm size 2>/dev/null | sed -n 's/^Physical size: //p' | head -1
}

# Maps a serial to the matrix width token, or prints nothing for an unknown size.
serial_width_token() {
  case "$(serial_size "$1")" in
    1080x1920) echo phone ;;
    2560x1600) echo pad ;;
    *) echo "" ;;
  esac
}

running_serials() {
  adb devices | awk 'NR > 1 && $2 == "device" { print $1 }'
}

boot_avd() {
  local avd="$1" serial="$2" emulator deadline pid
  emulator="$HOME/Library/Android/sdk/emulator/emulator"
  [ -x "$emulator" ] || emulator="$(command -v emulator || true)"
  if [ -z "$emulator" ]; then
    echo "Android emulator binary not found; start $avd from Android Studio, then re-run." >&2
    return 1
  fi
  echo "No $avd-size device is connected. Booting $avd headless (no window) as $serial;"
  echo "this takes a few minutes and no user interaction is required." >&2
  "$emulator" -avd "$avd" -port "${serial#emulator-}" -no-window -no-audio -no-boot-anim \
    -no-snapshot-save -gpu swiftshader_indirect >"$STAGING/emulator-$avd.log" 2>&1 &
  pid=$!
  deadline=$((SECONDS + 300))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | grep -q '^1$'; then
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Emulator $avd exited during boot:" >&2
      tail -20 "$STAGING/emulator-$avd.log" >&2 || true
      return 1
    fi
    sleep 5
  done
  echo "Emulator $avd did not finish booting within 300s." >&2
  return 1
}

# Copies one width's capture set out of the instrumented run into the matrix names.
collect_android() {
  local width="$1" shots="$ANDROID_RAW/iteration-1/attempt-1/screenshots/$ANDROID_CLASS"
  local spec page state note source theme
  while IFS='|' read -r source page state note; do
    [ -z "$source" ] && continue
    for theme in light dark; do
      record_shot "$shots/$source-$width-$theme.png" "$page-$state-$theme-$width.png" \
        "$page" "$state" "$theme" "$width" "$note"
    done
  done <<'SPECS'
podcast-resume-show|podcasts-show|normal|节目页：续听中的单集行
podcast-resume-show-notice|podcasts-show|resume-notice|节目页：已听完提示条
podcast-resume-menu|episode-menu|normal|单集操作菜单（进行中）
podcast-resume-menu-completed|episode-menu|completed|单集操作菜单（已完成，可标为未听）
podcast-resume-ask|ask-dialog|ask|续听询问弹窗
podcast-resume-conflict|player|conflict|播放页：设备冲突提示
podcast-resume-takeover|player|takeover|接管后的播放页
podcast-resume-settings|settings|podcast-resume|播客设置：续听方式
SPECS
}

capture_android() {
  check_avd_keyboard "$ANDROID_PHONE_AVD" || return 1
  check_avd_keyboard "$ANDROID_PAD_AVD" || return 1

  local serial token avd
  serial="$(running_serials | head -1)"
  if [ -z "$serial" ]; then
    boot_avd "$ANDROID_PHONE_AVD" emulator-5554 || return 1
    serial="emulator-5554"
  fi
  adb -s "$serial" wait-for-device
  token="$(serial_width_token "$serial")"
  case "$token" in
    phone) avd="$ANDROID_PHONE_AVD" ;;
    pad) avd="$ANDROID_PAD_AVD" ;;
    *)
      echo "Device $serial reports size '$(serial_size "$serial")'; expected 1080x1920 (Phone) or 2560x1600 (Pad)." >&2
      return 1
      ;;
  esac
  echo "Capturing $token ($avd) on $serial"
  # A cold emulator spends its instrumentation startup loading dex; on a loaded host that alone
  # can trip the 20s process-start ANR ("Process crashed" before any test is discovered).
  # Precompiling both APKs costs about a minute and removes that failure. Opt-in so the script
  # never silently spends the time on a warm device: WILDSTRING_SHOT_PRECOMPILE=1.
  if [ "${WILDSTRING_SHOT_PRECOMPILE:-0}" = "1" ]; then
    echo "Precompiling the app and test APKs (WILDSTRING_SHOT_PRECOMPILE=1)"
    adb -s "$serial" shell cmd package compile -m speed -f com.wildstring.app.dev \
      >"$STAGING/compile-app.log" 2>&1 || true
    adb -s "$serial" shell cmd package compile -m speed -f com.wildstring.app.dev.test \
      >"$STAGING/compile-test.log" 2>&1 || true
  fi
  # Keep the runner's default one retry: the first instrumentation can crash while the device is
  # still settling, and losing the whole capture to that is not useful. Pin the device so a
  # second emulator cannot receive the install.
  if ! (cd "$ROOT" && ANDROID_SERIAL="$serial" make android-instrumented-test \
    ANDROID_TEST_CLASSES="$ANDROID_CLASS" ANDROID_TEST_REPEAT=1 ANDROID_TEST_RETRIES=1 \
    >"$STAGING/instrumented-$token.log" 2>&1); then
    tail -40 "$STAGING/instrumented-$token.log" >&2 || true
    echo "Instrumented run on $serial failed; the log tail is above." >&2
    return 1
  fi
  collect_android "$token"
  return 0
}

# --- macos -----------------------------------------------------------------

capture_macos() {
  local out_dir="$STAGING/macos" theme
  mkdir -p "$out_dir"
  # The resume render writes to fixed /tmp paths; clear them so an old file cannot pass as new.
  rm -f /tmp/wildstring-resume-settings-light.png /tmp/wildstring-resume-settings-dark.png \
    /tmp/wildstring-resume-player-light.png /tmp/wildstring-resume-player-dark.png
  echo "Rendering macOS views in-process with NSHostingView (no app launch, no screen recording permission)"
  # xcodebuild only forwards TEST_RUNNER_-prefixed variables into the test process; without it the
  # renders fall back to /tmp and the captures look missing. Swift Testing identifiers need the
  # trailing "()" or xcodebuild silently runs zero tests.
  if ! (cd "$ROOT" && TEST_RUNNER_WILDSTRING_SCREENSHOT_DIR="$out_dir" xcodebuild \
    -project frontend/macos/WildStringMac.xcodeproj -scheme WildString \
    -destination 'platform=macOS' -configuration Debug \
    -derivedDataPath artifacts/macos-test-derived.noindex CODE_SIGN_IDENTITY=- \
    '-only-testing:WildStringMacTests/MacAssistantTests/podcastsNarrowViewWithBufferingRowRendersInBothSchemes()' \
    '-only-testing:WildStringMacTests/MacAssistantTests/queuePopupKeepsShellLayoutStableAndRendersFavoritesInBothSchemes()' \
    '-only-testing:WildStringMacTests/MacAssistantTests/renderPodcastResumeSurfacesWithIsolatedSession()' \
    test >"$STAGING/macos.log" 2>&1); then
    tail -40 "$STAGING/macos.log" >&2 || true
    echo "macOS test run failed; the log tail is above." >&2
    return 1
  fi
  for theme in light dark; do
    record_shot "$out_dir/wildstring-mac-podcasts-narrow-$theme.png" \
      "podcasts-show-narrow-$theme-narrow.png" \
      podcasts-show narrow "$theme" narrow "窄栏节目页与缓冲中的单集行"
    record_shot "$out_dir/wildstring-mac-shell-favorites-queue-$theme.png" \
      "queue-open-$theme-wide.png" \
      queue open "$theme" wide "宽栏外壳与队列浮层"
    record_shot "/tmp/wildstring-resume-player-$theme.png" \
      "player-conflict-$theme-wide.png" \
      player conflict "$theme" wide "播放器条的续听冲突提示"
    record_shot "/tmp/wildstring-resume-settings-$theme.png" \
      "settings-podcast-resume-$theme-wide.png" \
      settings podcast-resume "$theme" wide "设置页：播客续听方式"
  done
  return 0
}

# --- run -------------------------------------------------------------------

status=0
case "$PLATFORM" in
  web) capture_web || status=1 ;;
  android) capture_android || status=1 ;;
  macos) capture_macos || status=1 ;;
  ios)
    echo "No quick trigger exists for iOS yet: there is no render-to-PNG test target."
    echo "Every iOS row is marked manual; see docs/screenshot-matrix.md and --window."
    ;;
esac

# --- index.md --------------------------------------------------------------

index="$OUT/index.md"
captured=0
missing_required=0
required=0
{
  echo "# $PLATFORM screenshots"
  echo
  echo "Generated by \`scripts/agent_shot.sh $PLATFORM\` from \`docs/screenshot-matrix.md\`."
  echo "Each file follows \`<page>-<state>-<theme>-<width>.png\`."
  echo
  echo "| file | page | state | theme | width | shows |"
  echo "| --- | --- | --- | --- | --- | --- |"
  for line in "${CAPTURED[@]:-}"; do
    [ -z "$line" ] && continue
    IFS='|' read -r file page state theme width note <<<"$line"
    echo "| $file | $page | $state | $theme | $width | $note |"
    captured=$((captured + 1))
  done
  echo
  echo "Captured **$captured** file(s)."
  echo
  echo "## Not covered"
  echo
  if [ "${#MISSING[@]}" -eq 0 ]; then
    echo "Every required quick row produced its files."
  else
    echo "| expected file | shows | why it is missing |"
    echo "| --- | --- | --- |"
    for line in "${MISSING[@]}"; do
      [ -z "$line" ] && continue
      IFS='|' read -r file page state theme width note reason <<<"$line"
      echo "| $file | $note | $reason |"
    done
    echo
    echo "Missing files come from the capture step above or from a width this run did not cover."
  fi
  echo
  echo "## Manual rows (user signs these off before delivery)"
  echo
  manual="$(matrix_rows | awk -F'\t' '$6 == "manual" { print "| " $2 " | " $3 " | " $4 " | " $5 " | " $7 " |" }')"
  if [ -n "$manual" ]; then
    echo "| page | state | themes | widths | how |"
    echo "| --- | --- | --- | --- | --- |"
    echo "$manual"
    echo
    echo "These have no automated trigger in this repository; do not treat their absence as a pass."
  else
    echo "None."
  fi
  echo
  echo "## Window-level sign-off (not run by this script)"
  echo
  echo "\`scripts/agent_shot.sh --window\` prints the commands for checking real window chrome,"
  echo "materials, focus rings and animations. It is a human step before a release, not part of"
  echo "the routine quick layer."
} >"$index"

# Required-state gating: only quick rows count, and only the widths this platform actually
# produced (Android captures one device per run; the other width is reported as not covered).
while IFS=$'\t' read -r ignored page state themes widths layer how; do
  [ -n "$ignored" ] || continue
  row_selected "$page" "$state" || continue
  [ "$layer" = "quick" ] || continue
  while IFS= read -r expected; do
    [ -z "$expected" ] && continue
    required=$((required + 1))
    [ -f "$OUT/$expected" ] || missing_required=$((missing_required + 1))
  done <<EOF
$(row_files "$page" "$state" "$themes" "$widths")
EOF
done <<EOF
$(matrix_rows)
EOF

if [ "$status" -ne 0 ]; then
  echo "A capture step failed; see the messages above." >&2
  exit 1
fi
if [ "$required" -eq 0 ]; then
  echo "No quick rows selected for $PLATFORM; nothing required."
  echo "Index: ${index#"$ROOT"/}"
  exit 0
fi
if [ "$missing_required" -gt 0 ]; then
  echo "$missing_required of $required required $PLATFORM screenshot(s) missing." >&2
  echo "Index: ${index#"$ROOT"/}" >&2
  exit 1
fi
echo "$required required $PLATFORM screenshot(s) present."
echo "Index: ${index#"$ROOT"/}"
