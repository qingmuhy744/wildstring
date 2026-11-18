#!/usr/bin/env bash
# Restart the pre-created Android CI emulator ("test" AVD) after a QEMU/GLES crash.
set -euo pipefail

SDK_ROOT="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
EMULATOR_BIN="$SDK_ROOT/emulator/emulator"
AVD_NAME="${ANDROID_AVD_NAME:-test}"
LOG_FILE="${ANDROID_EMULATOR_RECOVERY_LOG:-/tmp/android-emulator-recovery.log}"

adb -s emulator-5554 emu kill >/dev/null 2>&1 || true
pkill -9 -f "qemu-system-.*-avd ${AVD_NAME}" >/dev/null 2>&1 || true
pkill -9 -f "emulator.*-avd ${AVD_NAME}" >/dev/null 2>&1 || true
sleep 2

nohup "$EMULATOR_BIN" \
  -port 5554 \
  -avd "$AVD_NAME" \
  -no-window \
  -gpu swiftshader \
  -feature -Vulkan \
  -no-snapshot \
  -noaudio \
  -no-boot-anim \
  -no-metrics \
  >"$LOG_FILE" 2>&1 &

timeout 180 adb wait-for-device
timeout 180 adb shell 'until [ "$(getprop sys.boot_completed)" = "1" ] && am get-started-user-state 0 2>/dev/null | grep -qx RUNNING_UNLOCKED && pm path android >/dev/null 2>&1; do sleep 2; done'

adb shell input keyevent 82 >/dev/null 2>&1 || true
adb shell settings put global window_animation_scale 0.0
adb shell settings put global transition_animation_scale 0.0
adb shell settings put global animator_duration_scale 0.0
