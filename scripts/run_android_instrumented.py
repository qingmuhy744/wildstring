"""Run the native instrumented suite one test class per instrumentation process.

A single ``connectedDebugAndroidTest`` run shares one app process across every class, so one
crash (for example a Compose assertion while an Activity is destroyed) reports every remaining
test as "not run" and fails the whole regression. Running each class in its own
``am instrument`` invocation keeps a crash inside the class that caused it, lets a retry repeat
only the classes that failed, and keeps every attempt's raw output, logcat and screenshots.

Usage (emulator already booted, APKs built with ``:app:assembleDebug :app:assembleDebugAndroidTest``):
  python scripts/run_android_instrumented.py --arg realBackend=http://10.0.2.2:19882/
  python scripts/run_android_instrumented.py --classes RecommendationExperienceTest --repeat 5 --retries 0
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess  # nosec B404 - runs adb and an operator-provided CI hook
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from xml.etree import ElementTree  # nosec B405 - only used to write reports

ROOT = Path(__file__).resolve().parents[1]
APK_DIR = ROOT / "frontend/android/app/build/outputs/apk"
DEFAULT_APP_APK = APK_DIR / "debug/app-debug.apk"
DEFAULT_TEST_APK = APK_DIR / "androidTest/debug/app-debug-androidTest.apk"
DEFAULT_OUTPUT = ROOT / "artifacts/android-instrumented"
TEST_PACKAGE_PREFIX = "com.wildstring.app."
RUNNER = "androidx.test.runner.AndroidJUnitRunner"
STATUS_PREFIX = "INSTRUMENTATION_STATUS: "
STATUS_CODE_PREFIX = "INSTRUMENTATION_STATUS_CODE: "
RESULT_PREFIX = "INSTRUMENTATION_RESULT: "
CODE_PREFIX = "INSTRUMENTATION_CODE: "
FAILED_PREFIX = "INSTRUMENTATION_FAILED: "
# AndroidJUnitRunner status codes.
START, OK, ERROR, FAILURE, IGNORED, ASSUMPTION = 1, 0, -1, -2, -3, -4


@dataclass
class TestCase:
    klass: str
    name: str
    status: str = "not-run"  # passed, failed, skipped, crashed, not-run
    message: str = ""


@dataclass
class Instrumentation:
    tests: list[TestCase] = field(default_factory=list)
    result: dict[str, str] = field(default_factory=dict)
    code: int | None = None
    failed: str = ""

    @property
    def crash(self) -> str:
        """Why the run ended early, or an empty string when it finished normally."""
        if self.failed:
            return self.failed
        message = self.result.get("shortMsg", "")
        if message or self.code is None:
            return message or "Instrumentation ended without a result"
        return ""


def parse_instrumentation(output: str) -> Instrumentation:
    """Parse ``am instrument -r`` raw output into per-test outcomes."""
    parsed = Instrumentation()
    status: dict[str, str] = {}
    result_mode = False
    key = ""
    started: dict[tuple[str, str], TestCase] = {}
    for line in output.splitlines():
        if line.startswith(STATUS_PREFIX):
            key, _, value = line[len(STATUS_PREFIX) :].partition("=")
            status[key] = value
            result_mode = False
        elif line.startswith(STATUS_CODE_PREFIX):
            code = int(line[len(STATUS_CODE_PREFIX) :].strip())
            identity = (status.get("class", ""), status.get("test", ""))
            if code == START and all(identity):
                case = TestCase(*identity)
                parsed.tests.append(case)
                started[identity] = case
            elif identity in started:
                case = started.pop(identity)
                if code == OK:
                    case.status = "passed"
                elif code in (IGNORED, ASSUMPTION):
                    case.status = "skipped"
                else:
                    case.status = "failed"
                    case.message = status.get("stack", "").strip()
            status = {}
            key = ""
        elif line.startswith(RESULT_PREFIX):
            key, _, value = line[len(RESULT_PREFIX) :].partition("=")
            parsed.result[key] = value
            result_mode = True
        elif line.startswith(CODE_PREFIX):
            parsed.code = int(line[len(CODE_PREFIX) :].strip())
        elif line.startswith(FAILED_PREFIX):
            parsed.failed = line[len(FAILED_PREFIX) :].strip()
        elif key:
            # Stack traces and streams continue over several physical lines.
            target = parsed.result if result_mode else status
            target[key] = target.get(key, "") + "\n" + line
    crash = parsed.crash
    for case in started.values():
        case.status = "crashed"
        case.message = crash or "Test did not report a result"
    return parsed


def adb(*arguments: str, timeout: float = 120, check: bool = True) -> str:
    completed = subprocess.run(  # nosec B603 B607 - fixed adb executable, no shell
        ["adb", *arguments], capture_output=True, text=True, timeout=timeout, check=False
    )
    if check and completed.returncode:
        raise RuntimeError(f"adb {' '.join(arguments)} failed: {completed.stderr.strip()}")
    return completed.stdout


def instrument(runner: str, extras: list[tuple[str, str]], timeout: float) -> tuple[str, bool]:
    command = ["shell", "am", "instrument", "-w", "-r"]
    for key, value in extras:
        command += ["-e", key, shlex.quote(value)]
    try:
        return adb(*command, runner, timeout=timeout, check=False), False
    except subprocess.TimeoutExpired as error:
        output = error.stdout or ""
        return output.decode() if isinstance(output, bytes) else output, True


def discover(runner: str, extras: list[tuple[str, str]]) -> dict[str, list[str]]:
    """List every test without running it (AndroidJUnitRunner log-only mode)."""
    output, _ = instrument(runner, [*extras, ("log", "true")], timeout=300)
    parsed = parse_instrumentation(output)
    classes: dict[str, list[str]] = {}
    for case in parsed.tests:
        classes.setdefault(case.klass, []).append(case.name)
    if not classes:
        raise SystemExit(f"No instrumented tests discovered:\n{output}")
    return classes


@dataclass
class ClassRun:
    klass: str
    attempt: int
    iteration: int
    tests: list[TestCase]
    crash: str
    timed_out: bool
    seconds: float

    @property
    def passed(self) -> bool:
        executed = [case for case in self.tests if case.status != "skipped"]
        return bool(executed) and all(case.status == "passed" for case in executed)

    @property
    def counts(self) -> dict[str, int]:
        counts = {"passed": 0, "failed": 0, "crashed": 0, "not-run": 0, "skipped": 0}
        for case in self.tests:
            counts[case.status] += 1
        return counts


def write_junit(run: ClassRun, path: Path) -> None:
    counts = run.counts
    suite = ElementTree.Element(
        "testsuite",
        name=run.klass,
        tests=str(len(run.tests)),
        failures=str(counts["failed"]),
        errors=str(counts["crashed"] + counts["not-run"]),
        skipped=str(counts["skipped"]),
        time=f"{run.seconds:.3f}",
    )
    for case in run.tests:
        element = ElementTree.SubElement(suite, "testcase", classname=case.klass, name=case.name)
        if case.status == "failed":
            ElementTree.SubElement(element, "failure", message=case.message.split("\n", 1)[0])
            element[-1].text = case.message
        elif case.status in ("crashed", "not-run"):
            reason = case.message or run.crash or "Not run"
            ElementTree.SubElement(element, "error", message=f"{case.status}: {reason}")
        elif case.status == "skipped":
            ElementTree.SubElement(element, "skipped")
    path.parent.mkdir(parents=True, exist_ok=True)
    ElementTree.ElementTree(suite).write(path, encoding="utf-8", xml_declaration=True)


def run_class(
    options: argparse.Namespace,
    klass: str,
    expected: list[str],
    iteration: int,
    attempt: int,
) -> ClassRun:
    short = klass.removeprefix(TEST_PACKAGE_PREFIX)
    directory = options.output / f"iteration-{iteration}" / f"attempt-{attempt}"
    device_output = f"/sdcard/Android/media/{options.app_package}/additional_test_output/{short}"
    adb("logcat", "-c", check=False)
    adb("shell", "rm", "-rf", device_output, check=False)
    began = time.monotonic()
    extras = [*options.extras, ("class", klass), ("additionalTestOutputDir", device_output)]
    output, timed_out = instrument(options.runner, extras, options.class_timeout)
    seconds = round(time.monotonic() - began, 3)
    if timed_out:
        adb("shell", "am", "force-stop", options.app_package, check=False)
        adb("shell", "am", "force-stop", options.test_package, check=False)
    parsed = parse_instrumentation(output)
    crash = f"Timed out after {options.class_timeout:.0f}s" if timed_out else parsed.crash
    reported = {case.name for case in parsed.tests}
    tests = parsed.tests + [
        TestCase(klass, name, "not-run", crash or "Not reported")
        for name in expected
        if name not in reported
    ]
    run = ClassRun(klass, attempt, iteration, tests, crash, timed_out, seconds)
    (directory / "raw").mkdir(parents=True, exist_ok=True)
    (directory / "raw" / f"{short}.txt").write_text(output)
    (directory / "logcat").mkdir(parents=True, exist_ok=True)
    logcat = adb("logcat", "-d", "-v", "threadtime", timeout=120, check=False)
    (directory / "logcat" / f"{short}.txt").write_text(logcat)
    screenshots = directory / "screenshots"
    screenshots.mkdir(parents=True, exist_ok=True)
    adb("pull", device_output, str(screenshots), timeout=300, check=False)
    write_junit(run, directory / f"TEST-{short}.xml")
    counts = run.counts
    verdict = "PASS" if run.passed else "FAIL"
    detail = f" ({crash})" if crash else ""
    print(
        f"[{verdict}] iteration {iteration} attempt {attempt} {short}: "
        f"{counts['passed']} passed, {counts['failed']} failed, "
        f"{counts['crashed'] + counts['not-run']} crashed/not run, "
        f"{counts['skipped']} skipped in {seconds:.0f}s{detail}",
        flush=True,
    )
    return run


def select(classes: dict[str, list[str]], wanted: str) -> dict[str, list[str]]:
    names = [name.strip() for name in wanted.split(",") if name.strip()]
    if not names:
        return classes
    selected: dict[str, list[str]] = {}
    for name in names:
        klass = name if "." in name else TEST_PACKAGE_PREFIX + name
        if klass not in classes:
            raise SystemExit(f"Unknown instrumented test class: {name}")
        selected[klass] = classes[klass]
    return selected


def summarize(runs: list[ClassRun], options: argparse.Namespace) -> bool:
    final: dict[tuple[int, str], ClassRun] = {}
    for run in runs:
        final[(run.iteration, run.klass)] = run
    flaky = sorted(
        {
            run.klass.removeprefix(TEST_PACKAGE_PREFIX)
            for run in runs
            if not run.passed and final[(run.iteration, run.klass)].passed
        }
    )
    failed = sorted(
        {key[1].removeprefix(TEST_PACKAGE_PREFIX) for key, run in final.items() if not run.passed}
    )
    executed = sum(run.counts["passed"] for run in final.values())
    lines = [
        "## Android instrumented tests (one process per class)",
        "",
        "| Iteration | Class | Attempt | Passed | Failed | Crashed/not run | Seconds | Note |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for run in runs:
        counts = run.counts
        lines.append(
            f"| {run.iteration} | {run.klass.removeprefix(TEST_PACKAGE_PREFIX)} | {run.attempt} "
            f"| {counts['passed']} | {counts['failed']} | {counts['crashed'] + counts['not-run']} "
            f"| {run.seconds:.0f} | {run.crash.replace('|', '/')[:120]} |"
        )
    lines += ["", f"Passed tests in final attempts: {executed}"]
    if flaky:
        lines.append(f"Passed only after a retry: {', '.join(flaky)}")
    if failed:
        lines.append(f"Still failing: {', '.join(failed)}")
    if options.repeat > 1:
        lines += ["", "| Class | First-attempt failures |", "| --- | --- |"]
        for klass in sorted({run.klass for run in runs}):
            firsts = [run for run in runs if run.klass == klass and run.attempt == 1]
            failures = sum(not run.passed for run in firsts)
            short = klass.removeprefix(TEST_PACKAGE_PREFIX)
            lines.append(f"| {short} | {failures}/{len(firsts)} |")
    text = "\n".join(lines) + "\n"
    (options.output / "summary.md").write_text(text)
    (options.output / "summary.json").write_text(
        json.dumps(
            [
                {
                    "iteration": run.iteration,
                    "class": run.klass,
                    "attempt": run.attempt,
                    "passed": run.passed,
                    "crash": run.crash,
                    "timed_out": run.timed_out,
                    "seconds": run.seconds,
                    "counts": run.counts,
                }
                for run in runs
            ],
            indent=2,
        )
    )
    print(text)
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(text)
    for name in flaky:
        print(f"::warning title=Flaky Android test class::{name} passed only after a retry")
    return not failed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--app-apk", type=Path, default=DEFAULT_APP_APK)
    parser.add_argument("--test-apk", type=Path, default=DEFAULT_TEST_APK)
    parser.add_argument("--app-package", default="com.wildstring.app.dev")
    parser.add_argument("--test-package", default="com.wildstring.app.dev.test")
    parser.add_argument("--no-install", action="store_true", help="Reuse installed APKs")
    parser.add_argument(
        "--arg",
        action="append",
        default=[],
        help="Instrumentation argument KEY=VALUE (also read from $ANDROID_TEST_ARGUMENTS)",
    )
    parser.add_argument("--classes", default="", help="Comma-separated classes; default all")
    parser.add_argument("--repeat", type=int, default=1, help="Run the selection N times")
    parser.add_argument("--retries", type=int, default=1, help="Retries for failed classes")
    parser.add_argument(
        "--before-retry",
        default=os.environ.get("ANDROID_TEST_BEFORE_RETRY", ""),
        help="Command run before each retry round (default: $ANDROID_TEST_BEFORE_RETRY)",
    )
    parser.add_argument("--class-timeout", type=float, default=900)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    options = parser.parse_args()
    options.runner = f"{options.test_package}/{RUNNER}"
    options.extras = []
    # CI passes extra arguments through the environment to avoid shell quoting in the
    # emulator runner's one-line script.
    for item in [*shlex.split(os.environ.get("ANDROID_TEST_ARGUMENTS", "")), *options.arg]:
        key, separator, value = item.partition("=")
        if not separator or not key:
            raise SystemExit(f"Instrumentation arguments must be KEY=VALUE: {item}")
        options.extras.append((key, value))
    if options.repeat < 1 or options.retries < 0:
        raise SystemExit("--repeat must be at least 1 and --retries cannot be negative")
    options.output.mkdir(parents=True, exist_ok=True)

    adb("wait-for-device", timeout=300)
    if not options.no_install:
        for apk in (options.app_apk, options.test_apk):
            if not apk.is_file():
                raise SystemExit(f"Missing APK {apk}; build :app:assembleDebugAndroidTest first")
            # -g matches connectedAndroidTest, which grants runtime permissions on install.
            adb("install", "-r", "-t", "-g", str(apk), timeout=600)
    classes = select(discover(options.runner, options.extras), options.classes)
    total = sum(len(names) for names in classes.values())
    print(f"Discovered {total} tests in {len(classes)} classes", flush=True)

    runs: list[ClassRun] = []
    for iteration in range(1, options.repeat + 1):
        pending = list(classes)
        for attempt in range(1, options.retries + 2):
            if attempt > 1:
                if not pending:
                    break
                if options.before_retry:
                    print(f"Before retry: {options.before_retry}", flush=True)
                    subprocess.run(  # nosec B603 - CI-provided hook, split without a shell
                        shlex.split(options.before_retry), check=True, timeout=300
                    )
            results = [
                run_class(options, klass, classes[klass], iteration, attempt) for klass in pending
            ]
            runs += results
            pending = [run.klass for run in results if not run.passed]
    if not summarize(runs, options):
        sys.exit(1)


if __name__ == "__main__":
    main()
