"""Verify the temporary exception with synthetic npm reports and a lockfile."""

import datetime as dt
import json
import sys
from pathlib import Path
from subprocess import CompletedProcess

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import audit_web_dependencies as gate  # noqa: E402


@pytest.mark.parametrize(
    ("scenario", "status"),
    [
        ("approved", 0),
        ("clean_after_expiry", 0),
        ("expired", 1),
        ("new_advisory", 1),
        ("production", 1),
        ("version_changed", 1),
        ("extra_instance", 1),
        ("audit_error", 1),
    ],
)
def test_web_audit_exception(scenario, status, tmp_path, monkeypatch, capsys):
    versions = {
        "picomatch": ("4.0.7", [{"url": gate.ADVISORY, "severity": "high"}]),
        "fdir": ("6.5.0", ["picomatch"]),
        "tinyglobby": ("0.2.17", ["picomatch", "fdir"]),
        "vite": ("8.3.8", ["tinyglobby", "picomatch"]),
        "@vitejs/plugin-react": ("6.3.0", ["vite"]),
    }
    packages = {
        f"node_modules/{name}": {"version": version, "dev": True}
        for name, (version, _) in versions.items()
    }
    findings = {
        name: {"nodes": [f"node_modules/{name}"], "severity": "high", "via": via}
        for name, (_, via) in versions.items()
    }
    report = {"auditReportVersion": 2, "vulnerabilities": findings}
    if scenario == "new_advisory":
        findings["vite"]["via"].append(
            {"url": "https://example.invalid/advisory", "severity": "low"}
        )
    if scenario == "production":
        packages["node_modules/picomatch"]["dev"] = False
    if scenario == "version_changed":
        packages["node_modules/vite"]["version"] = "8.3.9"
    if scenario == "extra_instance":
        findings["picomatch"]["nodes"].append("node_modules/vite/node_modules/picomatch")
    if scenario == "audit_error":
        report["error"] = {"code": "E503"}
    if scenario == "clean_after_expiry":
        findings.clear()
    if scenario in {"expired", "clean_after_expiry"}:
        monkeypatch.setattr(gate, "EXPIRES", dt.datetime.now(dt.UTC) - dt.timedelta(seconds=1))
    else:
        monkeypatch.setattr(gate, "EXPIRES", dt.datetime.now(dt.UTC) + dt.timedelta(days=1))

    (tmp_path / "package-lock.json").write_text(json.dumps({"packages": packages}))
    monkeypatch.setattr(gate, "WEB", tmp_path)
    raw = json.dumps(report) + "\n"

    def audit(command, **kwargs):
        assert "--include=dev" in command
        assert kwargs["cwd"] == tmp_path
        return CompletedProcess(command, int(scenario != "clean_after_expiry"), stdout=raw)

    monkeypatch.setattr(gate.subprocess, "run", audit)
    assert gate.main() == status
    assert capsys.readouterr().out.startswith(raw)
