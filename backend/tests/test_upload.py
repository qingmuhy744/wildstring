"""Tests for file and folder uploading, metadata enrichment, duplicate detection and sidecars."""

import shutil
from pathlib import Path

from mutagen.flac import FLAC

FIXTURE = Path(__file__).resolve().parents[2] / "tests/fixtures/audio/silence.flac"
HEADERS = {"X-Wildstring-Client": "web"}


def create_flac_bytes(
    tmp_path: Path,
    title: str | None = None,
    artist: str | None = None,
    album: str | None = None,
    tracknumber: int | None = None,
    discnumber: int | None = None,
) -> bytes:
    temp_file = tmp_path / "sample.flac"
    shutil.copyfile(FIXTURE, temp_file)
    tags = FLAC(temp_file)
    tags.clear()
    if title:
        tags["title"] = [title]
    if artist:
        tags["artist"] = [artist]
    if album:
        tags["album"] = [album]
    if tracknumber:
        tags["tracknumber"] = [str(tracknumber)]
    if discnumber:
        tags["discnumber"] = [str(discnumber)]
    tags.save()
    return temp_file.read_bytes()


def test_upload_standard_audio_and_sidecar_lrc(settings, authenticated_client, tmp_path):
    audio_bytes = create_flac_bytes(
        tmp_path,
        title="爱在西元前",
        artist="周杰伦",
        album="范特西",
        tracknumber=1,
    )
    with authenticated_client(settings) as client:
        # 1. Upload audio file
        response = client.post(
            "/api/v1/manage/library/upload",
            headers=HEADERS,
            files={"file": ("01.爱在西元前.flac", audio_bytes, "audio/flac")},
            data={"relative_path": "周杰伦/范特西/01.爱在西元前.flac", "auto_scan": "true"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "imported"
        assert data["title"] == "爱在西元前"
        assert data["artist"] == "周杰伦"
        assert data["album"] == "范特西"
        assert data["track_number"] == 1
        assert "CD01/01 - 爱在西元前.flac" in data["target_path"]
        assert (settings.library_dir / data["target_path"]).exists()

        # 2. Upload companion lyric (.lrc)
        lrc_content = "[00:01.00]古巴比伦王颁布了汉谟拉比法典\n".encode()
        lyric_res = client.post(
            "/api/v1/manage/library/upload",
            headers=HEADERS,
            files={"file": ("01.爱在西元前.lrc", lrc_content, "text/plain")},
            data={"relative_path": "周杰伦/范特西/01.爱在西元前.lrc"},
        )
        assert lyric_res.status_code == 200
        lyric_data = lyric_res.json()
        assert lyric_data["status"] == "imported"
        target_lyric_path = settings.library_dir / data["target_path"]
        expected_lyric = target_lyric_path.with_suffix(".lrc")
        assert expected_lyric.exists()
        assert expected_lyric.read_bytes() == lrc_content


def test_upload_duplicate_detection(settings, authenticated_client, tmp_path):
    audio_bytes = create_flac_bytes(
        tmp_path, title="晴天", artist="周杰伦", album="叶惠美", tracknumber=3
    )
    with authenticated_client(settings) as client:
        res1 = client.post(
            "/api/v1/manage/library/upload",
            headers=HEADERS,
            files={"file": ("03.晴天.flac", audio_bytes, "audio/flac")},
            data={"relative_path": "叶惠美/03.晴天.flac"},
        )
        assert res1.status_code == 200
        assert res1.json()["status"] == "imported"

        # Second upload with same bytes
        res2 = client.post(
            "/api/v1/manage/library/upload",
            headers=HEADERS,
            files={"file": ("03.晴天.flac", audio_bytes, "audio/flac")},
            data={"relative_path": "叶惠美/03.晴天.flac"},
        )
        assert res2.status_code == 200
        assert res2.json()["status"] == "duplicate"
        assert res2.json()["target_path"] == res1.json()["target_path"]


def test_upload_inferred_track_and_album_from_filename(settings, authenticated_client, tmp_path):
    # Audio has NO tags at all
    temp_file = tmp_path / "raw.flac"
    shutil.copyfile(FIXTURE, temp_file)
    tags = FLAC(temp_file)
    tags.clear()
    tags.save()
    raw_flac = temp_file.read_bytes()

    with authenticated_client(settings) as client:
        # Path mimics: 草东没有派对 - 瓦合 (2023) [24bit FLAC]/01. 丑.flac
        response = client.post(
            "/api/v1/manage/library/upload",
            headers=HEADERS,
            files={"file": ("01. 丑.flac", raw_flac, "audio/flac")},
            data={
                "relative_path": "草东没有派对 - 瓦合 (2023) [24bit FLAC]/01. 丑.flac",
                "auto_scan": "true",
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "imported"
        assert data["track_number"] == 1
        assert data["title"] == "丑"  # Leading '01. ' stripped!
        assert data["artist"] == "草东没有派对"
        assert data["album"] == "瓦合"
        assert "草东没有派对/瓦合/CD01/01 - 丑.flac" in data["target_path"]


def test_upload_with_overrides(settings, authenticated_client, tmp_path):
    audio_bytes = create_flac_bytes(tmp_path, title="未知歌曲")
    with authenticated_client(settings) as client:
        response = client.post(
            "/api/v1/manage/library/upload",
            headers=HEADERS,
            files={"file": ("track.flac", audio_bytes, "audio/flac")},
            data={
                "relative_path": "track.flac",
                "override_artist": "自定义艺人",
                "override_album": "自定义专辑",
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["artist"] == "自定义艺人"
        assert data["album"] == "自定义专辑"
        assert "自定义艺人/自定义专辑" in data["target_path"]


def test_upload_unsupported_format(settings, authenticated_client):
    with authenticated_client(settings) as client:
        response = client.post(
            "/api/v1/manage/library/upload",
            headers=HEADERS,
            files={"file": ("malicious.exe", b"fake binary", "application/octet-stream")},
            data={"relative_path": "malicious.exe"},
        )
        assert response.status_code == 400
        assert "unsupported_audio_format" in response.json()["detail"]
