"""Tests for the Android instrumented-suite shard split."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import run_android_instrumented  # noqa: E402

CLASSES = {f"com.wildstring.app.Class{index:02d}Test": ["test"] for index in range(7)}


def _options(
    tmp_path: Path, *, max_restarts: int = 2, recover_cmd: str = "recover"
) -> argparse.Namespace:
    return argparse.Namespace(
        repeat=1,
        retries=1,
        before_retry="",
        recover_device=recover_cmd,
        max_device_restarts=max_restarts,
        output=tmp_path,
        no_install=True,
    )


def _class_run(
    klass: str,
    *,
    attempt: int,
    passed: bool,
    device_lost: bool = False,
) -> run_android_instrumented.ClassRun:
    return run_android_instrumented.ClassRun(
        klass=klass,
        attempt=attempt,
        iteration=1,
        tests=[
            run_android_instrumented.TestCase(
                klass=klass,
                name="case",
                status="passed" if passed else "crashed",
            )
        ],
        crash="" if passed else "emulator lost",
        timed_out=False,
        seconds=5.0,
        device_lost=device_lost,
    )


def test_shards_cover_every_class_exactly_once() -> None:
    seen: list[str] = []
    for index in range(3):
        seen.extend(run_android_instrumented.shard(CLASSES, index, 3))
    assert sorted(seen) == sorted(CLASSES)
    assert len(seen) == len(set(seen))


def test_shards_stay_balanced() -> None:
    sizes = [len(run_android_instrumented.shard(CLASSES, index, 2)) for index in range(2)]
    assert max(sizes) - min(sizes) <= 1


def test_shards_spread_heavy_classes_by_test_count() -> None:
    weighted = {
        "com.wildstring.app.MobileCompletionTest": [f"t{i}" for i in range(13)],
        "com.wildstring.app.PodcastPresentationTest": [f"t{i}" for i in range(8)],
        "com.wildstring.app.CatalogToolbarLayoutTest": [f"t{i}" for i in range(7)],
        "com.wildstring.app.NativePlaybackTest": [f"t{i}" for i in range(6)],
        "com.wildstring.app.QueueReorderTest": [f"t{i}" for i in range(6)],
        "com.wildstring.app.TinyATest": ["t0"],
        "com.wildstring.app.TinyBTest": ["t0"],
        "com.wildstring.app.TinyCTest": ["t0"],
    }
    shards = [run_android_instrumented.shard(weighted, idx, 4) for idx in range(4)]
    combined = [klass for bucket in shards for klass in bucket]
    assert sorted(combined) == sorted(weighted)

    def shard_of(short: str) -> int:
        full = f"com.wildstring.app.{short}"
        return next(idx for idx, bucket in enumerate(shards) if full in bucket)

    # Top 4 heaviest suites must land on 4 separate shards.
    top_four = {
        shard_of("MobileCompletionTest"),
        shard_of("PodcastPresentationTest"),
        shard_of("CatalogToolbarLayoutTest"),
        shard_of("NativePlaybackTest"),
    }
    assert len(top_four) == 4


def test_single_shard_keeps_the_whole_selection() -> None:
    assert run_android_instrumented.shard(CLASSES, 0, 1) == CLASSES


def test_invalid_shard_arguments_are_rejected() -> None:
    with pytest.raises(SystemExit, match="shard-index"):
        run_android_instrumented.shard(CLASSES, 2, 2)
    with pytest.raises(SystemExit, match="shard-count"):
        run_android_instrumented.shard(CLASSES, 0, 0)


def test_execute_recovers_device_and_finishes_remaining_and_retried_classes(
    monkeypatch, tmp_path: Path
) -> None:
    classes = {
        "com.wildstring.app.FirstTest": ["case"],
        "com.wildstring.app.SecondTest": ["case"],
    }
    calls: list[tuple[str, int]] = []
    recoveries: list[str] = []

    monkeypatch.setattr(run_android_instrumented, "device_ready", lambda timeout=60: True)

    def fake_run_class(options, klass, expected, iteration, attempt):
        calls.append((klass, attempt))
        if klass.endswith("FirstTest") and attempt == 1:
            return _class_run(klass, attempt=attempt, passed=False, device_lost=True)
        return _class_run(klass, attempt=attempt, passed=True, device_lost=False)

    def fake_recover(options, label, restarts):
        recoveries.append(label)
        return True

    monkeypatch.setattr(run_android_instrumented, "run_class", fake_run_class)
    monkeypatch.setattr(run_android_instrumented, "recover_device", fake_recover)

    runs: list[run_android_instrumented.ClassRun] = []
    options = _options(tmp_path)
    run_android_instrumented.execute(options, classes, runs)
    ok = run_android_instrumented.summarize(runs, options)

    assert ok is True
    assert recoveries == ["after FirstTest"]
    assert calls == [
        ("com.wildstring.app.FirstTest", 1),
        ("com.wildstring.app.SecondTest", 1),
        ("com.wildstring.app.FirstTest", 2),
    ]
    summary = (tmp_path / "summary.md").read_text()
    assert "Recovered emulator 1 time(s)" in summary
    assert "no retries were attempted" not in summary


def test_execute_stops_when_recovery_exhausted_or_disabled(monkeypatch, tmp_path: Path) -> None:
    classes = {
        "com.wildstring.app.FirstTest": ["case"],
        "com.wildstring.app.SecondTest": ["case"],
    }
    monkeypatch.setattr(run_android_instrumented, "device_ready", lambda timeout=60: True)
    monkeypatch.setattr(
        run_android_instrumented,
        "run_class",
        lambda options, klass, expected, iteration, attempt: _class_run(
            klass, attempt=attempt, passed=False, device_lost=True
        ),
    )
    monkeypatch.setattr(
        run_android_instrumented, "recover_device", lambda options, label, restarts: False
    )

    runs: list[run_android_instrumented.ClassRun] = []
    options = _options(tmp_path, max_restarts=0, recover_cmd="")
    run_android_instrumented.execute(options, classes, runs)
    ok = run_android_instrumented.summarize(runs, options)

    assert ok is False
    assert [r.klass for r in runs] == list(classes)
    assert runs[1].seconds == 0.0
    summary = (tmp_path / "summary.md").read_text()
    assert "1 class runs were not started" in summary


def test_dismiss_system_error_dialogs_noop_without_error_window(monkeypatch) -> None:
    commands: list[tuple[str, ...]] = []

    def fake_adb(*args: str, **kwargs) -> str:
        commands.append(args)
        return "Window{abc u0 com.wildstring.app.dev/com.wildstring.app.MainActivity}\n"

    monkeypatch.setattr(run_android_instrumented, "adb", fake_adb)

    assert run_android_instrumented.dismiss_system_error_dialogs({"com.wildstring.app.dev"}) == []
    assert commands == [("shell", "dumpsys", "window", "windows")]


def test_dismiss_system_error_dialogs_stops_launcher_and_keeps_protected(monkeypatch) -> None:
    commands: list[tuple[str, ...]] = []
    dumpsys_calls = 0

    def fake_adb(*args: str, **kwargs) -> str:
        nonlocal dumpsys_calls
        commands.append(args)
        if args == ("shell", "dumpsys", "window", "windows"):
            dumpsys_calls += 1
            if dumpsys_calls == 1:
                return (
                    "Window{4d9ffc9 u0 Application Not Responding: com.android.launcher3}\n"
                    "Window{111 u0 Application Not Responding: com.wildstring.app.dev}\n"
                    "Window{222 u0 Application Not Responding: com.wildstring.app.dev.test}\n"
                    "Window{333 u0 Application Error: android}\n"
                    "Window{444 u0 Application Not Responding: com.android.systemui}\n"
                )
            return "Window{abc u0 com.wildstring.app.dev/com.wildstring.app.MainActivity}\n"
        return ""

    monkeypatch.setattr(run_android_instrumented, "adb", fake_adb)

    cleared = run_android_instrumented.dismiss_system_error_dialogs(
        {"com.wildstring.app.dev", "com.wildstring.app.dev.test"}
    )

    assert cleared == ["com.android.launcher3"]
    assert (
        "shell",
        "am",
        "broadcast",
        "-a",
        "android.intent.action.CLOSE_SYSTEM_DIALOGS",
    ) in commands
    assert ("shell", "am", "force-stop", "com.android.launcher3") in commands
    assert all(
        args[:3] != ("shell", "am", "force-stop") or args[3] == "com.android.launcher3"
        for args in commands
    )
    assert all("uiautomator" not in args for args in commands)


def test_dismiss_system_error_dialogs_falls_back_to_tapping_wait(monkeypatch) -> None:
    commands: list[tuple[str, ...]] = []

    def fake_adb(*args: str, **kwargs) -> str:
        commands.append(args)
        if args == ("shell", "dumpsys", "window", "windows"):
            return "Window{4d9ffc9 u0 Application Not Responding: com.android.launcher3}\n"
        if args == ("shell", "cat", "/sdcard/wildstring-anr.xml"):
            return (
                "<hierarchy>"
                '<node text="Wait" resource-id="android:id/aerr_wait" bounds="[100,200][300,280]" />'
                '<node text="Close app" resource-id="android:id/aerr_close" bounds="[100,100][300,180]" />'
                "</hierarchy>"
            )
        return ""

    monkeypatch.setattr(run_android_instrumented, "adb", fake_adb)

    cleared = run_android_instrumented.dismiss_system_error_dialogs({"com.wildstring.app.dev"})

    assert cleared == ["com.android.launcher3"]
    assert ("shell", "uiautomator", "dump", "/sdcard/wildstring-anr.xml") in commands
    assert ("shell", "cat", "/sdcard/wildstring-anr.xml") in commands
    assert ("shell", "input", "tap", "200", "240") in commands
