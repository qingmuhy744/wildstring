"""Deterministic library checks describe evidence, never establish musical facts."""

import json
from collections import defaultdict
from typing import Literal

from wildstring.library.metadata import normalize

Rule = Literal[
    "inspection_context_limited",
    "missing_title",
    "missing_artist",
    "missing_album",
    "missing_cover",
    "missing_lyrics",
    "missing_track_number",
    "track_number_conflict",
    "track_number_out_of_range",
    "disc_number_out_of_range",
    "missing_disc_number",
    "same_title_versions",
    "possible_duplicate_recording",
    "possible_multidisc_split",
]
GROUPING_LIMIT = 10000

RULES = {
    "inspection_context_limited": ("相关分组上下文超过一万首上限，本次结构检查可能不完整", "info"),
    "missing_title": ("缺少歌名", "warning"),
    "missing_artist": ("缺少艺人", "warning"),
    "missing_album": ("缺少专辑", "info"),
    "missing_cover": ("缺少封面，可选择已查询的封面候选", "info"),
    "missing_lyrics": ("未读到歌词；纯音乐或无歌词作品可能正常", "info"),
    "missing_track_number": ("未标曲序；单曲可能正常，需核对发行版本", "info"),
    "track_number_conflict": ("同专辑、同碟内曲序重复", "warning"),
    "track_number_out_of_range": ("曲序超过标签声明的曲目总数", "warning"),
    "disc_number_out_of_range": ("碟号超过标签声明的总碟数", "warning"),
    "missing_disc_number": ("声明为多碟发行但缺少碟号", "warning"),
    "same_title_versions": ("同专辑同名歌曲时长不同，需核对版本标记；不要直接删除", "info"),
    "possible_duplicate_recording": ("同专辑同名且时长接近；不能据此认定重复音频", "info"),
    "possible_multidisc_split": ("多碟发行可能因缺少专辑艺人而分组；核对版本后批量整理", "info"),
}


def catalog():
    return {
        "items": [
            {"code": code, "summary": value[0], "severity": value[1], "auto_apply": False}
            for code, value in RULES.items()
        ],
        "grouping_limit": GROUPING_LIMIT,
        "note": "本地规则仅提示字段缺失或结构冲突；不证明发行事实、音频重复或歌词同步。",
    }


class InspectionIndex:
    def __init__(self, repository):
        with repository.database.connect() as db:
            rows = db.execute(
                "SELECT t.id,t.title,t.artists,t.album,t.album_id,t.album_artists,"
                "t.track_number,t.disc_number,t.duration_ms,t.extra,m.version "
                "FROM tracks t JOIN track_metadata m ON m.track_id=t.id "
                "WHERE t.library_id=? AND t.status='available' ORDER BY t.id LIMIT ?",
                (repository.library_id(), GROUPING_LIMIT + 1),
            ).fetchall()
        self.truncated = len(rows) > GROUPING_LIMIT
        rows = rows[:GROUPING_LIMIT]
        self.tracks = {
            r["id"]: dict(r)
            | {
                "artists": json.loads(r["artists"]),
                "album_artists": json.loads(r["album_artists"]),
                "extra": json.loads(r["extra"]),
            }
            for r in rows
        }
        self.positions, self.titles, self.discs = (
            defaultdict(list),
            defaultdict(list),
            defaultdict(list),
        )
        for row in self.tracks.values():
            if row["track_number"] is not None:
                self.positions[
                    (row["album_id"], row["disc_number"] or 1, row["track_number"])
                ].append(row)
            artists = tuple(sorted(normalize(a) for a in row["artists"]))
            self.titles[(row["album_id"], normalize(row["title"]), artists)].append(row)
            # Cross-folder grouping is only a hint when explicit multi-disc tags support it.
            if (
                not row["album_artists"]
                and row["album"]
                and artists
                and row["extra"].get("disc_total", 0)
                and row["extra"]["disc_total"] > 1
            ):
                self.discs[(normalize(row["album"]), artists, row["extra"]["disc_total"])].append(
                    row
                )

    def findings(self, track, has_lyrics=None):
        findings = []

        def add(code, **evidence):
            summary, severity = RULES[code]
            findings.append({"code": code, "summary": summary, "severity": severity, **evidence})

        if self.truncated:
            add("inspection_context_limited")
        for field, code in (
            ("title", "missing_title"),
            ("artists", "missing_artist"),
            ("album", "missing_album"),
            ("has_cover", "missing_cover"),
        ):
            if not track.get(field):
                add(code)
        if has_lyrics is False:
            add("missing_lyrics")
        if track.get("track_number") is None:
            add("missing_track_number")
        row = self.tracks.get(track["id"])
        if row is None or row["version"] != track["metadata_version"]:
            return findings
        extra = row["extra"]
        for field, total, code in (
            ("track_number", "track_total", "track_number_out_of_range"),
            ("disc_number", "disc_total", "disc_number_out_of_range"),
        ):
            if row[field] and extra.get(total) and row[field] > extra[total]:
                add(code, value=row[field], declared_total=extra[total])
        if extra.get("disc_total", 0) and extra["disc_total"] > 1 and row["disc_number"] is None:
            add("missing_disc_number", declared_total=extra["disc_total"])
        peers = self.positions.get(
            (row["album_id"], row["disc_number"] or 1, row["track_number"]), []
        )
        if len(peers) > 1:
            add(
                "track_number_conflict",
                disc_number=row["disc_number"] or 1,
                track_number=row["track_number"],
                related_track_ids=[r["id"] for r in peers[:20]],
            )
        artists = tuple(sorted(normalize(a) for a in row["artists"]))
        peers = self.titles[(row["album_id"], normalize(row["title"]), artists)]
        if len(peers) > 1:
            durations = [r["duration_ms"] for r in peers]
            add(
                "same_title_versions"
                if max(durations) - min(durations) > 2500
                else "possible_duplicate_recording",
                related_track_ids=[r["id"] for r in peers[:20]],
                duration_range_ms=[min(durations), max(durations)],
            )
        peers = self.discs.get(
            (normalize(row["album"] or ""), artists, extra.get("disc_total")), []
        )
        albums = {r["album_id"] for r in peers}
        disc_sets = [
            {r["disc_number"] for r in peers if r["album_id"] == album and r["disc_number"]}
            for album in albums
        ]
        if (
            len(albums) > 1
            and all(disc_sets)
            and len(set().union(*disc_sets)) > 1
            and sum(map(len, disc_sets)) == len(set().union(*disc_sets))
        ):
            add("possible_multidisc_split", related_album_ids=sorted(albums)[:20])
        return findings
