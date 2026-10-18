"""Describe actual timing/language coverage, never infer quality from file suffixes."""

from wildstring.library.online_lyrics import display_lyrics

LABELS = ("无歌词", "静态歌词", "逐行动态", "双语逐行动态", "逐字动态", "双语逐字动态")


def quality(value):
    value = display_lyrics(value)
    lines = [line for line in value["lines"] if line["text"].strip()]
    count = len(lines)
    timed = sum(line.get("time_ms") is not None for line in lines) / max(1, count)
    words = sum(bool(line.get("words")) for line in lines) / max(1, count)
    translated = sum(bool(line.get("translation")) for line in lines) / max(1, count)
    starts = [line["time_ms"] for line in lines if line.get("time_ms") is not None]
    synced = value["kind"] == "synced" and timed >= 0.8 and starts == sorted(starts)
    word_timed, bilingual = synced and words >= 0.8, synced and translated >= 0.8
    level = (
        (5 if bilingual else 4)
        if word_timed
        else (3 if bilingual else 2)
        if synced
        else int(bool(count))
    )
    return {
        "level": level,
        "label": LABELS[level],
        "word_timed": word_timed,
        "bilingual": bilingual,
        "word_coverage": round(words, 3),
        "translation_coverage": round(translated, 3),
        "lines": count,
    }


def rank(level, preference="timing"):
    return (0, 1, 2, 4, 3, 5)[level] if preference == "bilingual" else level


def improves(before, after, preference="timing"):
    return (
        rank(after["level"], preference) > rank(before["level"], preference)
        and not (before["word_timed"] and not after["word_timed"])
        and not (before["bilingual"] and not after["bilingual"])
    )


def reaches(value, goal):
    return (
        value["level"] >= 1
        if goal == 1
        else value["level"] >= 2
        if goal == 2
        else value["bilingual"]
        if goal == 3
        else value["word_timed"]
        if goal == 4
        else value["word_timed"] and value["bilingual"]
    )


def matched(candidate):
    value = candidate["match"]
    difference = value.get("duration_difference_ms")
    return (
        not value["version_mismatch"]
        and value["score"] >= 0.9
        and difference is not None
        and difference <= 2500
    )
