"""Check retry classification with synthetic Gradle output and no backoff delay."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/retry_on_429.sh"
PLUGIN_MISSING = "Plugin Repositories (could not resolve plugin artifact 'example:plugin:1')"
RATE_LIMITED = "Received status code 429 from server: Too Many Requests"


@pytest.mark.skipif(
    not SCRIPT.is_file(),
    reason="the container test image omits shell CI scripts; the host run covers this",
)
@pytest.mark.parametrize(
    ("failures", "modes", "delays", "status"),
    [
        ([PLUGIN_MISSING], ["false:false", "true:true"], ["30"], 0),
        ([RATE_LIMITED], ["false:false", "false:true"], ["30"], 0),
        (
            [PLUGIN_MISSING, RATE_LIMITED],
            ["false:false", "true:true", "false:true"],
            ["30", "60"],
            0,
        ),
        ([PLUGIN_MISSING + "\n" + RATE_LIMITED], ["false:false", "false:true"], ["30"], 0),
        (["HTTP status 429"], ["false:false", "false:true"], ["30"], 0),
        (["Server returned HTTP response code: 429"], ["false:false", "false:true"], ["30"], 0),
        (
            ["Received status code 503 from server: Service Unavailable"],
            ["false:false", "false:true"],
            ["30"],
            0,
        ),
        (
            ["java.net.SocketTimeoutException: Read timed out"],
            ["false:false", "false:true"],
            ["30"],
            0,
        ),
        ([PLUGIN_MISSING] * 3, ["false:false", "true:true", "false:true"], ["30", "60"], 23),
        (["Execution failed for task ':app:compileDebugKotlin'"], ["false:false"], [], 23),
    ],
)
def test_gradle_retry_classification(tmp_path, failures, modes, delays, status):
    attempts = tmp_path / "attempts"
    backoff = tmp_path / "backoff"
    sleep = tmp_path / "sleep"
    sleep.write_text('#!/bin/sh\nprintf "%s\\n" "$1" >> "$BACKOFF"\n')
    sleep.chmod(0o755)
    command = (
        "import json, os, sys\n"
        "from pathlib import Path\n"
        "attempts = Path(os.environ['ATTEMPTS'])\n"
        "with attempts.open('a') as out:\n"
        "    print(\n"
        "        f\"{os.environ['WILDSTRING_GRADLE_REFRESH_DEPENDENCIES']}:\"\n"
        "        f\"{os.environ['WILDSTRING_GRADLE_STACKTRACE']}\",\n"
        "        file=out,\n"
        "    )\n"
        "failures = json.loads(sys.argv[1])\n"
        "index = len(attempts.read_text().splitlines()) - 1\n"
        "if index < len(failures):\n"
        "    print(failures[index])\n"
        "    sys.exit(23)\n"
    )
    result = subprocess.run(
        ["bash", str(SCRIPT), sys.executable, "-c", command, json.dumps(failures)],
        env=os.environ
        | {
            "ATTEMPTS": str(attempts),
            "BACKOFF": str(backoff),
            "PATH": os.pathsep.join((str(tmp_path), os.environ["PATH"])),
        },
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == status, result.stdout + result.stderr
    assert attempts.read_text().splitlines() == modes
    assert (backoff.read_text().splitlines() if backoff.exists() else []) == delays
    assert result.stderr.count("Retrying") == len(delays)
