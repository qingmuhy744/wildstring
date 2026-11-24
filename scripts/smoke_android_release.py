"""Verify the real optimized release APK can install and render its connection UI."""

import subprocess
import time
import xml.etree.ElementTree as ElementTree
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONNECTION_COPY = (
    ("连接自己的音乐收藏", "连接并登录"),
    ("Connect to your music collection", "Connect & sign in"),
)


def adb(*arguments: str, check: bool = True) -> bytes:
    return subprocess.run(["adb", *arguments], check=check, capture_output=True, timeout=120).stdout


def main() -> None:
    packages = list((ROOT / "artifacts/android-release").glob("wildstring-*-release.apk"))
    if len(packages) != 1:
        raise ValueError("Expected exactly one signed release APK")
    output = ROOT / "artifacts/android-release-smoke"
    output.mkdir(parents=True, exist_ok=True)
    adb("install", "-r", str(packages[0]))
    adb("shell", "settings", "put", "global", "hide_error_dialogs", "1", check=False)
    adb("shell", "settings", "put", "secure", "anr_show_background", "0", check=False)
    adb("shell", "wm", "dismiss-keyguard", check=False)
    adb("shell", "am", "broadcast", "-a", "android.intent.action.CLOSE_SYSTEM_DIALOGS", check=False)
    windows = adb("shell", "dumpsys", "window", "windows", check=False).decode(
        "utf-8", errors="replace"
    )
    if (
        "Application Not Responding: com.android.launcher3" in windows
        or "Application Error: com.android.launcher3" in windows
    ):
        adb("shell", "am", "force-stop", "com.android.launcher3", check=False)
    response = adb("shell", "am", "start", "-W", "-n", "com.wildstring.app/.MainActivity")
    if b"Error" in response:
        raise RuntimeError(response.decode())
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        adb("shell", "uiautomator", "dump", "/sdcard/wildstring-release-smoke.xml")
        xml = adb("exec-out", "cat", "/sdcard/wildstring-release-smoke.xml")
        (output / "connection.xml").write_bytes(xml)
        # The hierarchy is produced locally by adb, not received from the app or network.
        root = ElementTree.fromstring(xml)  # nosec B314
        texts = {node.get("text") for node in root.iter() if node.get("text")}
        if any(set(labels).issubset(texts) for labels in CONNECTION_COPY):
            if {"允许本机调试 HTTP", "Allow local debug HTTP"} & texts:
                raise RuntimeError("Debug-only HTTP control leaked into the release")
            (output / "connection.png").write_bytes(adb("exec-out", "screencap", "-p"))
            print("Signed release installed and rendered the real connection UI")
            return
        time.sleep(1)
    raise RuntimeError("Release connection UI did not appear; inspect the captured hierarchy")


if __name__ == "__main__":
    main()
