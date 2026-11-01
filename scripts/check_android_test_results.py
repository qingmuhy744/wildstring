"""Reject empty connected-test runs even when Gradle reports success."""

from pathlib import Path
from xml.etree import ElementTree  # nosec B405 - local Android test reports

REPORTS = (
    Path(__file__).resolve().parents[1]
    / "frontend/android/app/build/outputs/androidTest-results/connected/debug"
)


def main() -> None:
    reports = sorted(REPORTS.rglob("TEST-*.xml"))
    if not reports:
        raise SystemExit("Android regression produced no test reports")
    executed = 0
    for path in reports:
        suite = ElementTree.parse(path).getroot()  # nosec B314 - local test output
        tests = int(suite.get("tests", "0"))
        skipped = int(suite.get("skipped", "0"))
        failures = int(suite.get("failures", "0")) + int(suite.get("errors", "0"))
        if tests <= skipped or failures:
            raise SystemExit(f"{path.name}: {tests} tests, {skipped} skipped, {failures} failures")
        executed += tests - skipped
    print(f"Android regression verified: {executed} executed, 0 failures")


if __name__ == "__main__":
    main()
