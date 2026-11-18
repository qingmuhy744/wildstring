"""Audit the complete Web lockfile with one expiring build dependency exception."""

import datetime as dt
import json
import subprocess
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "frontend/web"
ADVISORY = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf"
EXPIRES = dt.datetime(2026, 11, 25, 0, 20, tzinfo=dt.UTC)
# Versions and npm's reported causes, including the indirect findings.
EXCEPTION = {
    "picomatch": ("4.0.7", {(ADVISORY, "high")}),
    "fdir": ("6.5.0", {"picomatch"}),
    "tinyglobby": ("0.2.17", {"fdir", "picomatch"}),
    "vite": ("8.3.8", {"picomatch", "tinyglobby"}),
    "@vitejs/plugin-react": ("6.3.0", {"vite"}),
}


def main() -> int:
    audit = subprocess.run(  # nosec B603 B607 - fixed command with no shell
        ["npm", "audit", "--package-lock-only", "--include=dev", "--audit-level=low", "--json"],
        cwd=WEB,
        check=False,
        stdout=subprocess.PIPE,
        text=True,
    )
    print(audit.stdout, end="", flush=True)
    if audit.returncode != 1:
        return audit.returncode

    try:
        report = json.loads(audit.stdout)
    except json.JSONDecodeError:
        return audit.returncode
    if report.get("auditReportVersion") != 2 or "error" in report:
        return audit.returncode
    findings = report["vulnerabilities"]
    if findings.keys() != EXCEPTION.keys():
        return audit.returncode
    if dt.datetime.now(dt.UTC) >= EXPIRES:
        print(f"Web build dependency exception expired at {EXPIRES.isoformat()}: {ADVISORY}")
        return audit.returncode

    locked = json.loads((WEB / "package-lock.json").read_text())["packages"]
    for name, (version, causes) in EXCEPTION.items():
        path = f"node_modules/{name}"
        package = locked.get(path, {})
        finding = findings[name]
        if (
            finding["nodes"] != [path]
            or finding["severity"] != "high"
            or package.get("version") != version
            or package.get("dev") is not True
        ):
            return audit.returncode
        via = finding["via"]
        actual = {
            cause if isinstance(cause, str) else (cause["url"], cause["severity"]) for cause in via
        }
        if actual != causes or len(via) != len(causes):
            return audit.returncode

    print(f"Accepted Web build dependency risk until {EXPIRES.isoformat()}: {ADVISORY}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
