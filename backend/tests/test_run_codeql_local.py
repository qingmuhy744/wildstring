import json
import re
import runpy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CODEQL = runpy.run_path(str(ROOT / "scripts/run_codeql_local.py"))


def test_languages_and_modes_match_ci():
    workflow = (ROOT / ".github/workflows/codeql.yml").read_text()
    matrix = dict(re.findall(r"- language: ([\w-]+)\n\s+build-mode: (\w+)", workflow))
    assert matrix == CODEQL["BUILD_MODES"]
    assert set(CODEQL["DEFAULT_LANGUAGES"]) == {name for name in matrix if matrix[name] == "none"}
    assert CODEQL["CONFIG"] in workflow


def test_summarize_sarif(tmp_path, capsys):
    sarif = tmp_path / "result.sarif"
    sarif.write_text(
        json.dumps(
            {
                "runs": [
                    {
                        "results": [
                            {
                                "ruleId": "py/example",
                                "message": {"text": "First line.\nSecond line."},
                                "locations": [
                                    {
                                        "physicalLocation": {
                                            "artifactLocation": {"uri": "a%20file.py"},
                                            "region": {"startLine": 12},
                                        }
                                    }
                                ],
                            },
                            {"ruleId": "py/other", "message": {"markdown": "No location"}},
                        ]
                    }
                ]
            }
        )
    )
    assert CODEQL["summarize"](sarif, "python") == 2
    assert capsys.readouterr().out.splitlines() == [
        "python: a file.py:12 [py/example] First line. Second line.",
        "python: (unknown file):? [py/other] No location",
    ]


def test_missing_cli_explains_installation(monkeypatch, capsys):
    monkeypatch.setenv("PATH", "")
    assert CODEQL["main"]([]) == 2
    assert "official CodeQL CLI bundle" in capsys.readouterr().err
