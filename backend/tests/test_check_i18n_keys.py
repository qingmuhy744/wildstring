import json
import runpy
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
I18N = runpy.run_path(str(ROOT / "scripts/check_i18n_keys.py"))


def test_missing_literal_key_reports_source_line_without_rejecting_plural_keys(
    tmp_path, monkeypatch
):
    source = tmp_path / "example.tsx"
    references = [
        [str(source), 2, "common.loading"],
        [str(source), 3, "items.count"],
        [str(source), 4, "common.missing"],
    ]
    monkeypatch.setattr(
        I18N["subprocess"],
        "run",
        lambda *args, **kwargs: SimpleNamespace(stdout=json.dumps(references)),
    )
    problems = I18N["check_web_references"](tmp_path, {"common.loading", "items.count_other"})
    assert problems == ["web: example.tsx:4: 'common.missing' is missing from locales"]
