#!/usr/bin/env python3
"""Checks that the Chinese and English interface strings stay in step.

Web:     frontend/web/src/locales/en.json vs zh-CN.json (same keys, same {{placeholders}})
Android: res/values/strings.xml vs res/values-zh/strings.xml (same names, same %1$s args)
iOS:     WildString/Localizable.xcstrings (every key translated to en and zh-Hans)
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from xml.etree import ElementTree  # nosec B405

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "frontend/web/src/locales"
ANDROID = ROOT / "frontend/android/app/src/main/res"
IOS = ROOT / "frontend/ios/WildString/Localizable.xcstrings"

WEB_PLACEHOLDER = re.compile(r"\{\{\s*([\w.]+)\s*\}\}")
FORMAT_ARG = re.compile(r"%(?:\d+\$)?[-#+ 0,]*\d*(?:\.\d+)?(?:ll|l|h)?[@dDuUxXoOfFeEgGcCsSaAp]")


def flatten(value: object, prefix: str = "") -> dict[str, str]:
    if isinstance(value, dict):
        out: dict[str, str] = {}
        for key, child in value.items():
            out.update(flatten(child, f"{prefix}{key}."))
        return out
    return {prefix[:-1]: str(value)}


def compare(
    platform: str,
    left_name: str,
    left: dict[str, str],
    right_name: str,
    right: dict[str, str],
    placeholders: re.Pattern[str],
) -> list[str]:
    problems = []
    for key in sorted(left.keys() - right.keys()):
        problems.append(f"{platform}: '{key}' is in {left_name} but missing from {right_name}")
    for key in sorted(right.keys() - left.keys()):
        problems.append(f"{platform}: '{key}' is in {right_name} but missing from {left_name}")
    for key in sorted(left.keys() & right.keys()):
        if not left[key].strip() or not right[key].strip():
            problems.append(f"{platform}: '{key}' has an empty translation")
        a = sorted(placeholders.findall(left[key]))
        b = sorted(placeholders.findall(right[key]))
        if a != b:
            problems.append(f"{platform}: '{key}' placeholders differ ({a} vs {b})")
    return problems


def check_web() -> list[str]:
    en = flatten(json.loads((WEB / "en.json").read_text(encoding="utf-8")))
    zh = flatten(json.loads((WEB / "zh-CN.json").read_text(encoding="utf-8")))
    return compare("web", "en.json", en, "zh-CN.json", zh, WEB_PLACEHOLDER)


def android_strings(path: Path) -> dict[str, str]:
    tree = ElementTree.parse(path)  # nosec B314
    return {node.attrib["name"]: "".join(node.itertext()) for node in tree.getroot().iter("string")}


def check_android() -> list[str]:
    en = android_strings(ANDROID / "values/strings.xml")
    zh = android_strings(ANDROID / "values-zh/strings.xml")
    return compare("android", "values", en, "values-zh", zh, FORMAT_ARG)


def check_ios() -> list[str]:
    document = json.loads(IOS.read_text(encoding="utf-8"))
    problems = []
    if document.get("sourceLanguage") != "en":
        problems.append("ios: Localizable.xcstrings sourceLanguage must be 'en'")
    en: dict[str, str] = {}
    zh: dict[str, str] = {}
    for key, entry in document.get("strings", {}).items():
        localizations = entry.get("localizations", {})
        for language, target in (("en", en), ("zh-Hans", zh)):
            unit = localizations.get(language, {}).get("stringUnit", {})
            if unit.get("state") == "translated" and unit.get("value"):
                target[key] = unit["value"]
    return problems + compare("ios", "en", en, "zh-Hans", zh, FORMAT_ARG)


def main() -> int:
    problems = check_web() + check_android() + check_ios()
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        print(f"{len(problems)} i18n problem(s) found.", file=sys.stderr)
        return 1
    print("i18n keys match for web, Android and iOS.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
