"""Podcast RSS subscription, server-side auto-updater, and playback API."""

import ipaddress
import json
import logging
import os
import queue
import re
import shutil
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from collections import deque
from datetime import UTC, datetime
from pathlib import Path
from threading import Event, Thread
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from wildstring.auth import Auth
from wildstring.database import Database
from wildstring.library.repository import now
from wildstring.outbound import outbound_proxies

logger = logging.getLogger(__name__)

ITUNES_NS = "{http://www.itunes.com/dtds/podcast-1.0.dtd}"
CONTENT_NS = "{http://purl.org/rss/1.0/modules/content/}"
MEDIA_NS = "{http://search.yahoo.com/mrss/}"
USER_AGENT = "WildString/1.0 (Audiobookshelf-compatible podcast player)"
MAX_FEED_BYTES = 8 * 1024 * 1024
MAX_COVER_BYTES = 8 * 1024 * 1024
MAX_AUDIO_BYTES = 1024 * 1024 * 1024


class PodcastURLRejected(ValueError):
    """Raised when a podcast URL could access a non-public local resource."""


class PodcastPayloadTooLarge(ValueError):
    """Raised when a remote podcast response exceeds its bounded size."""


class PodcastDownloadCancelled(Exception):
    """Raised internally when a deleted podcast cancels an active download."""


def validate_remote_url(value: str) -> str:
    """Allow only bounded HTTP(S) podcast resources, never local URL schemes."""
    raw = value.strip()
    if not raw or any(ord(char) < 32 or char.isspace() for char in raw):
        raise PodcastURLRejected("invalid_remote_url")
    try:
        parsed = urlsplit(raw)
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise PodcastURLRejected("invalid_remote_url")
    except ValueError as exc:
        raise PodcastURLRejected("invalid_remote_url") from exc
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise PodcastURLRejected("invalid_remote_url")
    if parsed.username or parsed.password:
        raise PodcastURLRejected("remote_url_credentials_not_allowed")

    hostname = parsed.hostname.rstrip(".").lower()
    if hostname in {"localhost", "localhost.localdomain"} or hostname.endswith(
        (".localhost", ".local", ".internal")
    ):
        raise PodcastURLRejected("remote_url_private_host")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise PodcastURLRejected("remote_url_private_host")
    return raw


class PodcastRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Keep redirects inside the same public HTTP(S) URL policy."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_remote_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def podcast_opener(proxy_mode: str, proxy_url: str | None):
    """Build one opener with proxy and redirect policy for every podcast request."""
    try:
        proxies = outbound_proxies(proxy_mode, proxy_url)
    except Exception as exc:
        logger.warning("Could not configure podcast proxy: %s", exc)
        proxies = {}
    return urllib.request.build_opener(
        urllib.request.ProxyHandler(proxies), PodcastRedirectHandler()
    )


def read_bounded(response, limit: int) -> bytes:
    data = response.read(limit + 1)
    if len(data) > limit:
        raise PodcastPayloadTooLarge("remote_response_too_large")
    return data


def podcast_folder_name(podcast_id: str) -> str:
    """Return a stable per-subscription folder name independent of its title."""
    safe_id = re.sub(r"[^A-Za-z0-9_-]", "_", podcast_id).strip("._-") or "unknown"
    return f"podcast-{safe_id[:96]}"


def sanitize_filename(name: str, max_len: int = 120) -> str:
    cleaned = re.sub(r'[\\/*?:"<>|]', "_", name).strip()
    cleaned = re.sub(r"\s+", " ", cleaned).strip(". ")
    return cleaned[:max_len] if cleaned else "untitled"


def format_speed(bytes_per_sec: float) -> str:
    if bytes_per_sec < 1024:
        return f"{bytes_per_sec:.0f} B/s"
    elif bytes_per_sec < 1024 * 1024:
        return f"{bytes_per_sec / 1024:.1f} KB/s"
    else:
        return f"{bytes_per_sec / (1024 * 1024):.1f} MB/s"


def format_bytes_human(n: int | float) -> str:
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if n < 1024.0:
            return f"{n:.1f} {unit}"
        n /= 1024.0
    return f"{n:.1f} PB"


class PodcastCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    feed_url: str = Field(min_length=5, max_length=1024)
    auto_update: bool = True
    update_interval_minutes: int = Field(default=60, ge=5, le=1440)
    download_policy: Literal["latest_3", "latest_5", "latest_10", "unplayed", "all", "none"] = (
        "latest_3"
    )
    retention_policy: Literal["keep", "delete_after_played"] = "keep"
    slow_download: bool = False
    max_retries: int = Field(default=3, ge=0, le=10)
    retry_backoff_base: int = Field(default=5, ge=1, le=60)

    @field_validator("feed_url")
    @classmethod
    def validate_feed_url(cls, value: str) -> str:
        return validate_remote_url(value)


class PodcastUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: str | None = Field(default=None, max_length=256)
    auto_update: bool | None = None
    update_interval_minutes: int | None = Field(default=None, ge=5, le=1440)
    download_policy: (
        Literal["latest_3", "latest_5", "latest_10", "unplayed", "all", "none"] | None
    ) = None
    retention_policy: Literal["keep", "delete_after_played"] | None = None
    slow_download: bool | None = None
    max_retries: int | None = Field(default=None, ge=0, le=10)
    retry_backoff_base: int | None = Field(default=None, ge=1, le=60)


class PodcastStorageResponse(BaseModel):
    podcast_id: str
    podcast_title: str
    storage_path: str
    relative_path: str
    total_episodes: int
    downloaded_episodes: int
    disk_usage_bytes: int
    disk_usage_human: str


class PodcastProgressRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    position_seconds: int = Field(default=0, ge=0)
    duration_seconds: int = Field(default=0, ge=0)
    completed: bool = False


class PodcastEpisodeResponse(BaseModel):
    id: str
    podcast_id: str
    guid: str
    title: str
    description: str
    audio_url: str
    duration_seconds: int
    pub_date: str
    episode_number: int | None = None
    season_number: int | None = None
    created_at: str
    position_seconds: int = 0
    completed: bool = False
    local_path: str | None = None
    download_status: str = "none"


class PodcastSummaryResponse(BaseModel):
    id: str
    title: str
    author: str
    description: str
    feed_url: str
    cover_url: str
    auto_update: bool
    update_interval_minutes: int
    download_policy: str = "latest_3"
    retention_policy: str = "keep"
    slow_download: bool = False
    max_retries: int = 3
    retry_backoff_base: int = 5
    last_updated_at: str | None
    created_at: str
    total_episodes: int
    unplayed_episodes: int
    downloaded_episodes: int = 0
    storage_path: str = ""


class PodcastDetailResponse(BaseModel):
    podcast: PodcastSummaryResponse
    episodes: list[PodcastEpisodeResponse]


def parse_duration(raw: str | None) -> int:
    if not raw:
        return 0
    raw = raw.strip()
    if ":" in raw:
        parts = raw.split(":")
        try:
            if len(parts) == 3:
                return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(float(parts[2]))
            if len(parts) == 2:
                return int(parts[0]) * 60 + int(float(parts[1]))
        except ValueError:
            return 0
    try:
        return int(float(raw))
    except ValueError:
        return 0


def fetch_and_parse_feed(
    feed_url: str,
    timeout: int = 25,
    proxy_mode: str = "environment",
    proxy_url: str | None = None,
) -> dict[str, Any]:
    try:
        feed_url = validate_remote_url(feed_url)
    except PodcastURLRejected as exc:
        raise HTTPException(status_code=422, detail="invalid_podcast_feed_url") from exc
    req = urllib.request.Request(
        feed_url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/rss+xml, application/xml, text/xml, application/atom+xml, */*",
        },
    )
    try:
        with podcast_opener(proxy_mode, proxy_url).open(req, timeout=timeout) as resp:  # nosec B310
            data = read_bounded(resp, MAX_FEED_BYTES)
    except PodcastPayloadTooLarge as exc:
        raise HTTPException(status_code=413, detail="podcast_feed_too_large") from exc
    except Exception as e:
        logger.error("Failed to fetch podcast feed host=%s: %s", urlsplit(feed_url).hostname, e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="无法获取播客 RSS 源",
        ) from e

    try:
        root = ET.fromstring(data)  # nosec B314
    except Exception as e:
        logger.error("Failed to parse podcast XML host=%s: %s", urlsplit(feed_url).hostname, e)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"RSS 源 XML 解析失败: {e}",
        ) from e

    channel = root.find("channel")
    if channel is None:
        # Check Atom feed
        if root.tag.endswith("feed"):
            return _parse_atom_feed(root, feed_url)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="无效的播客源：未找到 channel 或 feed 根节点",
        )

    title = channel.findtext("title") or "未命名播客"
    author = (
        channel.findtext(f"{ITUNES_NS}author")
        or channel.findtext("author")
        or channel.findtext(f"{ITUNES_NS}owner/{ITUNES_NS}name")
        or ""
    )
    description = channel.findtext("description") or channel.findtext(f"{ITUNES_NS}summary") or ""

    cover_url = ""
    itunes_img = channel.find(f"{ITUNES_NS}image")
    if itunes_img is not None and itunes_img.attrib.get("href"):
        cover_url = itunes_img.attrib.get("href", "").strip()
    elif channel.find("image/url") is not None:
        cover_url = channel.findtext("image/url") or ""
    try:
        cover_url = validate_remote_url(cover_url) if cover_url else ""
    except PodcastURLRejected:
        cover_url = ""

    episodes: list[dict[str, Any]] = []
    for item in channel.findall("item"):
        ep_title = item.findtext("title") or "无标题单集"
        guid = item.findtext("guid")
        pub_date = item.findtext("pubDate") or ""
        ep_desc = (
            item.findtext("description")
            or item.findtext(f"{ITUNES_NS}summary")
            or item.findtext(f"{CONTENT_NS}encoded")
            or ""
        )

        audio_url = ""
        enclosure = item.find("enclosure")
        if enclosure is not None and enclosure.attrib.get("url"):
            audio_url = enclosure.attrib.get("url", "").strip()
        else:
            media_content = item.find(f"{MEDIA_NS}content")
            if media_content is not None and media_content.attrib.get("url"):
                audio_url = media_content.attrib.get("url", "").strip()
            else:
                link = item.findtext("link")
                if link and (link.endswith(".mp3") or link.endswith(".m4a")):
                    audio_url = link.strip()

        if not audio_url:
            continue
        try:
            audio_url = validate_remote_url(audio_url)
        except PodcastURLRejected:
            logger.warning("Skipping podcast episode with unsafe audio URL")
            continue

        if not guid:
            guid = audio_url

        duration_sec = parse_duration(item.findtext(f"{ITUNES_NS}duration"))

        ep_num = None
        raw_ep = item.findtext(f"{ITUNES_NS}episode")
        if raw_ep and raw_ep.strip().isdigit():
            ep_num = int(raw_ep.strip())

        season_num = None
        raw_season = item.findtext(f"{ITUNES_NS}season")
        if raw_season and raw_season.strip().isdigit():
            season_num = int(raw_season.strip())

        episodes.append(
            {
                "guid": guid,
                "title": ep_title.strip(),
                "description": ep_desc.strip(),
                "audio_url": audio_url,
                "duration_seconds": duration_sec,
                "pub_date": pub_date.strip(),
                "episode_number": ep_num,
                "season_number": season_num,
            }
        )

    return {
        "title": title.strip(),
        "author": author.strip(),
        "description": description.strip(),
        "cover_url": cover_url.strip(),
        "episodes": episodes,
    }


def _parse_atom_feed(root: ET.Element, feed_url: str) -> dict[str, Any]:
    atom_ns = "{http://www.w3.org/2005/Atom}"
    title = root.findtext(f"{atom_ns}title") or "未命名播客"
    author = root.findtext(f"{atom_ns}author/{atom_ns}name") or ""
    description = root.findtext(f"{atom_ns}subtitle") or ""
    cover_url = ""
    icon = root.findtext(f"{atom_ns}icon") or root.findtext(f"{atom_ns}logo")
    if icon:
        try:
            cover_url = validate_remote_url(icon)
        except PodcastURLRejected:
            cover_url = ""

    episodes: list[dict[str, Any]] = []
    for entry in root.findall(f"{atom_ns}entry"):
        ep_title = entry.findtext(f"{atom_ns}title") or "无标题单集"
        guid = entry.findtext(f"{atom_ns}id")
        pub_date = (
            entry.findtext(f"{atom_ns}published") or entry.findtext(f"{atom_ns}updated") or ""
        )
        ep_desc = entry.findtext(f"{atom_ns}summary") or entry.findtext(f"{atom_ns}content") or ""

        audio_url = ""
        for link in entry.findall(f"{atom_ns}link"):
            rel = link.attrib.get("rel", "")
            type_attr = link.attrib.get("type", "")
            if rel == "enclosure" or "audio" in type_attr:
                audio_url = link.attrib.get("href", "").strip()
                break

        if not audio_url:
            continue
        try:
            audio_url = validate_remote_url(audio_url)
        except PodcastURLRejected:
            logger.warning("Skipping podcast episode with unsafe audio URL")
            continue
        if not guid:
            guid = audio_url

        episodes.append(
            {
                "guid": guid,
                "title": ep_title.strip(),
                "description": ep_desc.strip(),
                "audio_url": audio_url,
                "duration_seconds": 0,
                "pub_date": pub_date.strip(),
                "episode_number": None,
                "season_number": None,
            }
        )

    return {
        "title": title.strip(),
        "author": author.strip(),
        "description": description.strip(),
        "cover_url": cover_url.strip(),
        "episodes": episodes,
    }


class PodcastManager:
    def __init__(
        self,
        database: Database,
        check_interval_seconds: int = 60,
        providers: Any | None = None,
        storage_dir: Path | None = None,
    ):
        self.database = database
        self.check_interval_seconds = check_interval_seconds
        self.providers = providers
        self.storage_dir = Path(storage_dir) if storage_dir else Path("data/podcasts")
        self.stopping = Event()
        self.thread: Thread | None = None

        # Download queue & workers
        self._download_queue: queue.Queue[str] = queue.Queue()
        self._queued_episodes: dict[str, dict[str, Any]] = {}
        self._active_downloads: dict[str, dict[str, Any]] = {}
        self._recent_completed: deque[dict[str, Any]] = deque(maxlen=40)
        self._failed_downloads: dict[str, dict[str, Any]] = {}
        self._download_workers: list[Thread] = []
        self._cancelled_downloads: set[str] = set()

    def _podcast_dir(self, podcast_id: str) -> Path:
        return self.storage_dir / podcast_folder_name(podcast_id)

    def _safe_local_path(self, value: str | None) -> Path | None:
        if not value:
            return None
        try:
            candidate = Path(value).resolve()
            root = self.storage_dir.resolve()
        except OSError:
            return None
        return candidate if candidate.is_relative_to(root) else None

    def _delete_local_paths(
        self, paths: list[str | None], *, protected: list[str | None] | None = None
    ) -> int:
        deleted = 0
        seen: set[Path] = set()
        protected_paths = {
            path
            for path in (self._safe_local_path(raw) for raw in (protected or []))
            if path is not None
        }
        for raw_path in paths:
            path = self._safe_local_path(raw_path)
            if path is None or path in seen or path in protected_paths:
                continue
            seen.add(path)
            try:
                if path.is_file():
                    path.unlink()
                    deleted += 1
            except OSError:
                continue
        return deleted

    def _ensure_schema(self) -> None:
        try:
            with self.database.connect(write=True) as conn:
                p_cols = {r[1] for r in conn.execute("PRAGMA table_info(podcasts)")}
                if p_cols:
                    if "download_policy" not in p_cols:
                        conn.execute(
                            "ALTER TABLE podcasts ADD COLUMN download_policy TEXT NOT NULL DEFAULT 'latest_3'"
                        )
                    if "retention_policy" not in p_cols:
                        conn.execute(
                            "ALTER TABLE podcasts ADD COLUMN retention_policy TEXT NOT NULL DEFAULT 'keep'"
                        )
                    if "slow_download" not in p_cols:
                        conn.execute(
                            "ALTER TABLE podcasts ADD COLUMN slow_download INTEGER NOT NULL DEFAULT 0"
                        )
                    if "max_retries" not in p_cols:
                        conn.execute(
                            "ALTER TABLE podcasts ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 3"
                        )
                    if "retry_backoff_base" not in p_cols:
                        conn.execute(
                            "ALTER TABLE podcasts ADD COLUMN retry_backoff_base INTEGER NOT NULL DEFAULT 5"
                        )

                columns = {r[1] for r in conn.execute("PRAGMA table_info(podcast_episodes)")}
                if columns:
                    if "local_path" not in columns:
                        conn.execute("ALTER TABLE podcast_episodes ADD COLUMN local_path TEXT")
                    if "download_status" not in columns:
                        conn.execute(
                            "ALTER TABLE podcast_episodes ADD COLUMN download_status TEXT NOT NULL DEFAULT 'none'"
                        )
        except Exception:
            # Table or columns may already exist during initialization
            pass

    def get_network_policy(self) -> tuple[str, str | None]:
        proxy_mode = "environment"
        proxy_url = None
        try:
            with self.database.connect() as conn:
                row = conn.execute(
                    "SELECT proxy_mode FROM provider_settings WHERE id = 1"
                ).fetchone()
                if row and row["proxy_mode"]:
                    proxy_mode = row["proxy_mode"]
            if self.providers is not None and hasattr(self.providers, "secrets"):
                proxy_url = self.providers.secrets().get("proxy_url")
        except Exception as e:
            logger.debug("Failed to read proxy policy: %s", e)
        return proxy_mode, proxy_url

    def start(self):
        self._ensure_schema()
        if self.thread is not None and self.thread.is_alive():
            return
        self.stopping.clear()
        self.thread = Thread(
            target=self._scheduler_loop,
            name="wildstring-podcast-scheduler",
            daemon=True,
        )
        self.thread.start()

        # Start 2 download workers
        self._download_workers = []
        for i in range(2):
            w = Thread(
                target=self._download_worker_loop,
                name=f"wildstring-podcast-downloader-{i + 1}",
                daemon=True,
            )
            w.start()
            self._download_workers.append(w)

        logger.info("Server-side podcast auto-updater and download workers started.")

    def stop(self):
        self.stopping.set()
        if self.thread is not None:
            self.thread.join(timeout=3)
            self.thread = None
        for w in self._download_workers:
            w.join(timeout=1)
        self._download_workers.clear()
        logger.info("Server-side podcast auto-updater thread stopped.")

    def _download_worker_loop(self):
        while not self.stopping.is_set():
            try:
                episode_id = self._download_queue.get(timeout=1)
            except queue.Empty:
                continue

            if episode_id in self._cancelled_downloads:
                self._cancelled_downloads.discard(episode_id)
                self._download_queue.task_done()
                continue

            info = self._queued_episodes.pop(episode_id, None)
            if not info:
                info = self._get_episode_display_info(episode_id)

            is_slow = bool(info.get("slow_download")) if info else False
            max_retries = int(info.get("max_retries", 3)) if info else 3
            backoff_base = int(info.get("retry_backoff_base", 5)) if info else 5

            if info:
                self._active_downloads[episode_id] = {
                    **info,
                    "status": "downloading",
                    "slow_mode": is_slow,
                    "attempt": 0,
                    "max_retries": max_retries,
                    "started_at": datetime.now(UTC).isoformat(),
                }

            success = False
            last_error = "下载失败"

            try:
                for attempt in range(max_retries + 1):
                    if self.stopping.is_set():
                        break

                    if attempt > 0:
                        # 指数回避：基准秒数 * 2^(attempt - 1)，最大上限 60 秒
                        backoff_sec = min(backoff_base * (2 ** (attempt - 1)), 60)
                        logger.info(
                            "Episode %s download retry %d/%d with exponential backoff: waiting %ds...",
                            episode_id,
                            attempt,
                            max_retries,
                            backoff_sec,
                        )
                        if episode_id in self._active_downloads:
                            self._active_downloads[episode_id].update(
                                {
                                    "status": "retrying",
                                    "attempt": attempt,
                                    "max_retries": max_retries,
                                    "backoff_seconds": backoff_sec,
                                    "error": f"第 {attempt}/{max_retries} 次重试等待中 ({backoff_sec}s): {last_error}",
                                }
                            )
                        # 支持快速退出的平缓休眠
                        for _ in range(int(backoff_sec * 10)):
                            if self.stopping.is_set():
                                break
                            time.sleep(0.1)

                        if self.stopping.is_set():
                            break

                    if episode_id in self._active_downloads:
                        self._active_downloads[episode_id].update(
                            {
                                "status": "downloading",
                                "attempt": attempt,
                                "max_retries": max_retries,
                                "error": None,
                            }
                        )

                    try:
                        success = self.download_episode(episode_id, slow_download=is_slow)
                        if success:
                            break
                        fail_rec = self._failed_downloads.get(episode_id)
                        if fail_rec and fail_rec.get("error"):
                            last_error = fail_rec["error"]
                    except Exception as exc:
                        last_error = str(exc)

                item = self._active_downloads.pop(episode_id, info or {})
                if episode_id in self._cancelled_downloads:
                    self._cancelled_downloads.discard(episode_id)
                    continue
                if success:
                    self._recent_completed.appendleft(
                        {
                            **item,
                            "status": "downloaded",
                            "completed_at": datetime.now(UTC).isoformat(),
                        }
                    )
                    self._failed_downloads.pop(episode_id, None)
                else:
                    self._failed_downloads[episode_id] = {
                        **item,
                        "status": "failed",
                        "error": last_error,
                        "failed_at": datetime.now(UTC).isoformat(),
                    }
            except Exception as e:
                item = self._active_downloads.pop(episode_id, info or {})
                self._failed_downloads[episode_id] = {
                    **item,
                    "status": "failed",
                    "error": str(e),
                    "failed_at": datetime.now(UTC).isoformat(),
                }
            finally:
                if is_slow and not self.stopping.is_set():
                    # 慢速防限流平缓模式：单集之间平缓延时 4 秒，防止源站并发触发频率限制
                    for _ in range(40):
                        if self.stopping.is_set():
                            break
                        time.sleep(0.1)
                self._download_queue.task_done()

    def _scheduler_loop(self):
        self.stopping.wait(timeout=5)
        while not self.stopping.is_set():
            try:
                self.run_scheduled_updates()
            except Exception as e:
                logger.error("Error during scheduled podcast updates: %s", e)
            self.stopping.wait(timeout=self.check_interval_seconds)

    def run_scheduled_updates(self) -> int:
        now_dt = datetime.now(UTC)
        with self.database.connect() as conn:
            rows = conn.execute(
                """
                SELECT id, title, feed_url, auto_update, update_interval_minutes, last_updated_at,
                       COALESCE(download_policy, 'latest_3') as download_policy,
                       COALESCE(retention_policy, 'keep') as retention_policy
                FROM podcasts
                WHERE auto_update = 1
                """
            ).fetchall()

        updated_count = 0
        for row in rows:
            if self.stopping.is_set():
                break
            podcast_id = row["id"]
            interval = row["update_interval_minutes"] or 60
            last_updated_str = row["last_updated_at"]
            policy = row["download_policy"]
            should_update = False
            if not last_updated_str:
                should_update = True
            else:
                try:
                    last_dt = datetime.fromisoformat(last_updated_str)
                    if (now_dt - last_dt).total_seconds() >= interval * 60:
                        should_update = True
                except Exception:
                    should_update = True

            if should_update:
                try:
                    logger.info("Auto-updating podcast: %s (%s)", row["title"], podcast_id)
                    self.refresh_podcast(podcast_id)
                    updated_count += 1
                    self._auto_download_by_policy(podcast_id, policy)
                except Exception as e:
                    logger.warning("Auto-update failed for podcast %s: %s", podcast_id, e)

        return updated_count

    def _auto_download_by_policy(self, podcast_id: str, policy: str) -> int:
        if policy == "none":
            return 0
        limit = None
        unplayed_only = False
        if policy == "latest_3":
            limit = 3
        elif policy == "latest_5":
            limit = 5
        elif policy == "latest_10":
            limit = 10
        elif policy == "unplayed":
            unplayed_only = True
        elif policy == "all":
            limit = None

        try:
            with self.database.connect() as conn:
                query = """
                    SELECT e.id FROM podcast_episodes e
                    LEFT JOIN podcast_progress pr ON pr.episode_id = e.id AND pr.user_id = 'admin'
                    WHERE e.podcast_id = ? AND (e.local_path IS NULL OR e.download_status != 'downloaded')
                """
                params: list[Any] = [podcast_id]
                if unplayed_only:
                    query += " AND COALESCE(pr.completed, 0) = 0"
                query += " ORDER BY e.created_at DESC"
                if limit:
                    query += f" LIMIT {limit}"

                episodes = conn.execute(query, params).fetchall()
            queued = 0
            for ep in episodes:
                if self.stopping.is_set():
                    break
                if self.queue_download_episode(ep["id"]):
                    queued += 1
            return queued
        except Exception as e:
            logger.warning("Auto-downloading by policy failed for %s: %s", podcast_id, e)
            return 0

    def subscribe(
        self,
        feed_url: str,
        auto_update: bool = True,
        update_interval_minutes: int = 60,
        download_policy: str = "latest_3",
        retention_policy: str = "keep",
        slow_download: bool = False,
        max_retries: int = 3,
        retry_backoff_base: int = 5,
    ) -> dict[str, Any]:
        with self.database.connect() as conn:
            existing = conn.execute(
                "SELECT id FROM podcasts WHERE feed_url = ?", (feed_url,)
            ).fetchone()
            if existing:
                podcast_id = existing["id"]
                self.refresh_podcast(podcast_id)
                return self.get_podcast_detail(podcast_id, user_id="admin")

        proxy_mode, proxy_url = self.get_network_policy()
        parsed = fetch_and_parse_feed(feed_url, proxy_mode=proxy_mode, proxy_url=proxy_url)
        podcast_id = str(uuid4())
        created_time = now()

        with self.database.connect(write=True) as conn:
            conn.execute(
                """
                INSERT INTO podcasts (
                    id, title, author, description, feed_url, cover_url,
                    auto_update, update_interval_minutes, download_policy, retention_policy,
                    slow_download, max_retries, retry_backoff_base, last_updated_at, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    podcast_id,
                    parsed["title"],
                    parsed["author"],
                    parsed["description"],
                    feed_url,
                    parsed["cover_url"],
                    1 if auto_update else 0,
                    update_interval_minutes,
                    download_policy,
                    retention_policy,
                    1 if slow_download else 0,
                    max_retries,
                    retry_backoff_base,
                    created_time,
                    created_time,
                ),
            )
            for ep in parsed["episodes"]:
                conn.execute(
                    """
                    INSERT INTO podcast_episodes (
                        id, podcast_id, guid, title, description, audio_url,
                        duration_seconds, pub_date, episode_number, season_number, created_at,
                        download_status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none')
                    """,
                    (
                        str(uuid4()),
                        podcast_id,
                        ep["guid"],
                        ep["title"],
                        ep["description"],
                        ep["audio_url"],
                        ep["duration_seconds"],
                        ep["pub_date"],
                        ep["episode_number"],
                        ep["season_number"],
                        created_time,
                    ),
                )

        logger.info(
            "Subscribed new podcast '%s' with %d episodes (proxy_mode=%s)",
            parsed["title"],
            len(parsed["episodes"]),
            proxy_mode,
        )
        if auto_update and download_policy != "none":
            self._auto_download_by_policy(podcast_id, download_policy)
        return self.get_podcast_detail(podcast_id, user_id="admin")

    def update_podcast(
        self,
        podcast_id: str,
        title: str | None = None,
        auto_update: bool | None = None,
        update_interval_minutes: int | None = None,
        download_policy: str | None = None,
        retention_policy: str | None = None,
        slow_download: bool | None = None,
        max_retries: int | None = None,
        retry_backoff_base: int | None = None,
    ) -> bool:
        with self.database.connect(write=True) as conn:
            row = conn.execute("SELECT * FROM podcasts WHERE id = ?", (podcast_id,)).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="播客未找到")
            new_title = title if title is not None else row["title"]
            new_auto = (1 if auto_update else 0) if auto_update is not None else row["auto_update"]
            new_interval = (
                update_interval_minutes
                if update_interval_minutes is not None
                else row["update_interval_minutes"]
            )
            new_policy = (
                download_policy
                if download_policy is not None
                else (row["download_policy"] if "download_policy" in row.keys() else "latest_3")
            )
            new_retention = (
                retention_policy
                if retention_policy is not None
                else (row["retention_policy"] if "retention_policy" in row.keys() else "keep")
            )
            new_slow = (
                (1 if slow_download else 0)
                if slow_download is not None
                else (row["slow_download"] if "slow_download" in row.keys() else 0)
            )
            new_retries = (
                max_retries
                if max_retries is not None
                else (row["max_retries"] if "max_retries" in row.keys() else 3)
            )
            new_backoff = (
                retry_backoff_base
                if retry_backoff_base is not None
                else (row["retry_backoff_base"] if "retry_backoff_base" in row.keys() else 5)
            )

            conn.execute(
                """
                UPDATE podcasts
                SET title = ?, auto_update = ?, update_interval_minutes = ?,
                    download_policy = ?, retention_policy = ?, slow_download = ?,
                    max_retries = ?, retry_backoff_base = ?
                WHERE id = ?
                """,
                (
                    new_title,
                    new_auto,
                    new_interval,
                    new_policy,
                    new_retention,
                    new_slow,
                    new_retries,
                    new_backoff,
                    podcast_id,
                ),
            )

        if new_auto and new_policy != "none":
            self._auto_download_by_policy(podcast_id, new_policy)
        return True

    def refresh_podcast(self, podcast_id: str) -> bool:
        with self.database.connect() as conn:
            row = conn.execute(
                "SELECT feed_url FROM podcasts WHERE id = ?", (podcast_id,)
            ).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="播客未找到")
            feed_url = row["feed_url"]

        proxy_mode, proxy_url = self.get_network_policy()
        parsed = fetch_and_parse_feed(feed_url, proxy_mode=proxy_mode, proxy_url=proxy_url)
        updated_time = now()

        with self.database.connect(write=True) as conn:
            conn.execute(
                """
                UPDATE podcasts
                SET title = ?, author = ?, description = ?, cover_url = ?, last_updated_at = ?
                WHERE id = ?
                """,
                (
                    parsed["title"],
                    parsed["author"],
                    parsed["description"],
                    parsed["cover_url"],
                    updated_time,
                    podcast_id,
                ),
            )
            for ep in parsed["episodes"]:
                conn.execute(
                    """
                    INSERT INTO podcast_episodes (
                        id, podcast_id, guid, title, description, audio_url,
                        duration_seconds, pub_date, episode_number, season_number, created_at,
                        download_status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none')
                    ON CONFLICT(podcast_id, guid) DO UPDATE SET
                        title = excluded.title,
                        description = excluded.description,
                        audio_url = excluded.audio_url,
                        duration_seconds = excluded.duration_seconds,
                        pub_date = excluded.pub_date,
                        episode_number = excluded.episode_number,
                        season_number = excluded.season_number
                    """,
                    (
                        str(uuid4()),
                        podcast_id,
                        ep["guid"],
                        ep["title"],
                        ep["description"],
                        ep["audio_url"],
                        ep["duration_seconds"],
                        ep["pub_date"],
                        ep["episode_number"],
                        ep["season_number"],
                        updated_time,
                    ),
                )
        return True

    def _ensure_podcast_metadata_files(self, podcast_dir: Path, p_data: Any) -> None:
        try:
            json_file = podcast_dir / "podcast.json"
            if not json_file.exists():
                meta = {
                    "title": p_data["podcast_title"],
                    "author": p_data["author"],
                    "feed_url": p_data["feed_url"],
                    "description": p_data["description"],
                    "created_at": datetime.now(UTC).isoformat(),
                }
                with open(json_file, "w", encoding="utf-8") as f:
                    json.dump(meta, f, ensure_ascii=False, indent=2)

            cover_file = podcast_dir / "cover.jpg"
            if not cover_file.exists() and p_data["cover_url"]:
                proxy_mode, proxy_url = self.get_network_policy()
                cover_url = validate_remote_url(p_data["cover_url"])
                req = urllib.request.Request(cover_url, headers={"User-Agent": USER_AGENT})
                temporary = podcast_dir / ".cover.jpg.part"
                with podcast_opener(proxy_mode, proxy_url).open(req, timeout=15) as resp:  # nosec B310
                    total = 0
                    with open(temporary, "wb") as stream:
                        while True:
                            chunk = resp.read(64 * 1024)
                            if not chunk:
                                break
                            total += len(chunk)
                            if total > MAX_COVER_BYTES:
                                raise PodcastPayloadTooLarge("podcast_cover_too_large")
                            stream.write(chunk)
                        stream.flush()
                        os.fsync(stream.fileno())
                temporary.replace(cover_file)
        except Exception as e:
            logger.debug("Failed saving podcast metadata files: %s", e)
            if "temporary" in locals():
                temporary.unlink(missing_ok=True)

    def download_episode(self, episode_id: str, slow_download: bool | None = None) -> bool:
        with self.database.connect() as conn:
            row = conn.execute(
                """
                SELECT e.id, e.podcast_id, e.title, e.audio_url, e.pub_date, e.episode_number,
                       e.local_path, e.download_status, p.title as podcast_title, p.cover_url,
                       p.author, p.feed_url, p.description,
                       COALESCE(p.slow_download, 0) as slow_download
                FROM podcast_episodes e
                JOIN podcasts p ON p.id = e.podcast_id
                WHERE e.id = ?
                """,
                (episode_id,),
            ).fetchone()
            if not row:
                return False
            episode_title = row["title"]
            audio_url = row["audio_url"]
            existing_path = row["local_path"]
            if existing_path and os.path.isfile(existing_path):
                return True
            is_slow = bool(row["slow_download"]) if slow_download is None else bool(slow_download)

        self.storage_dir.mkdir(parents=True, exist_ok=True)
        podcast_dir = self._podcast_dir(row["podcast_id"])
        podcast_dir.mkdir(parents=True, exist_ok=True)

        self._ensure_podcast_metadata_files(podcast_dir, row)

        pub_date_prefix = ""
        if row["pub_date"]:
            try:
                dt = datetime.fromisoformat(row["pub_date"])
                pub_date_prefix = dt.strftime("%Y-%m-%d")
            except Exception:
                try:
                    from email.utils import parsedate_to_datetime

                    dt = parsedate_to_datetime(row["pub_date"])
                    pub_date_prefix = dt.strftime("%Y-%m-%d")
                except Exception:
                    pub_date_prefix = sanitize_filename(row["pub_date"][:10])

        ep_prefix = f"#{row['episode_number']} " if row["episode_number"] else ""
        filename = (
            f"{pub_date_prefix} - {ep_prefix}{sanitize_filename(episode_title)} [{episode_id}].mp3"
        ).strip(" -")
        if not filename.endswith(".mp3"):
            filename += ".mp3"

        dest_path = podcast_dir / filename
        temp_path = podcast_dir / f"{filename}.part"

        with self.database.connect(write=True) as conn:
            conn.execute(
                "UPDATE podcast_episodes SET download_status = 'downloading' WHERE id = ?",
                (episode_id,),
            )

        proxy_mode, proxy_url = self.get_network_policy()
        opener = podcast_opener(proxy_mode, proxy_url)

        try:
            audio_url = validate_remote_url(audio_url)
            req = urllib.request.Request(
                audio_url,
                headers={"User-Agent": USER_AGENT, "Accept": "*/*"},
            )
            with opener.open(req, timeout=45) as resp:  # nosec B310
                content_len = resp.headers.get("Content-Length")
                total_bytes = int(content_len) if content_len and content_len.isdigit() else -1
                if total_bytes > MAX_AUDIO_BYTES:
                    raise PodcastPayloadTooLarge("podcast_audio_too_large")

                downloaded_bytes = 0
                start_t = time.time()
                last_sample_t = start_t
                last_sample_bytes = 0

                chunk_size = 32 * 1024 if is_slow else 64 * 1024
                target_bps = 512 * 1024 if is_slow else None

                with open(temp_path, "wb") as f:
                    while True:
                        if self.stopping.is_set():
                            raise Exception("下载已被停止")
                        t_chunk_start = time.perf_counter()
                        chunk = resp.read(chunk_size)
                        if not chunk:
                            break
                        f.write(chunk)
                        downloaded_bytes += len(chunk)
                        if downloaded_bytes > MAX_AUDIO_BYTES:
                            raise PodcastPayloadTooLarge("podcast_audio_too_large")
                        if episode_id in self._cancelled_downloads:
                            raise PodcastDownloadCancelled

                        if target_bps:
                            min_duration = len(chunk) / target_bps
                            elapsed = time.perf_counter() - t_chunk_start
                            if min_duration > elapsed:
                                sleep_time = min_duration - elapsed
                                while sleep_time > 0 and not self.stopping.is_set():
                                    step = min(sleep_time, 0.05)
                                    time.sleep(step)
                                    sleep_time -= step

                        now_t = time.time()
                        delta = now_t - last_sample_t
                        if delta >= 0.5:
                            speed_bps = (downloaded_bytes - last_sample_bytes) / delta
                            last_sample_t = now_t
                            last_sample_bytes = downloaded_bytes
                            pct = (
                                round(downloaded_bytes / total_bytes * 100, 1)
                                if total_bytes > 0
                                else None
                            )
                            if episode_id in self._active_downloads:
                                self._active_downloads[episode_id].update(
                                    {
                                        "downloaded_bytes": downloaded_bytes,
                                        "total_bytes": total_bytes,
                                        "progress_pct": pct,
                                        "speed_bps": round(speed_bps, 1),
                                        "speed_human": format_speed(speed_bps),
                                        "downloaded_human": format_bytes_human(downloaded_bytes),
                                        "total_human": (
                                            format_bytes_human(total_bytes)
                                            if total_bytes > 0
                                            else "未知大小"
                                        ),
                                        "slow_mode": is_slow,
                                    }
                                )

            if episode_id in self._cancelled_downloads:
                raise PodcastDownloadCancelled
            temp_path.replace(dest_path)
            with self.database.connect(write=True) as conn:
                conn.execute(
                    "UPDATE podcast_episodes SET local_path = ?, download_status = 'downloaded' WHERE id = ?",
                    (str(dest_path), episode_id),
                )
            self._failed_downloads.pop(episode_id, None)
            logger.info("Successfully downloaded episode %s to %s", episode_id, dest_path)
            return True
        except PodcastDownloadCancelled:
            temp_path.unlink(missing_ok=True)
            return False
        except PodcastPayloadTooLarge:
            self._record_failed(episode_id, row, "播客音频超过大小限制", temp_path)
            return False
        except urllib.error.HTTPError as e:
            if e.code == 429:
                err_msg = "源站频繁请求限流 (HTTP 429 Too Many Requests)，已启动防限流冷却"
                # 冷却退避 15 秒，保护源站
                for _ in range(150):
                    if self.stopping.is_set():
                        break
                    time.sleep(0.1)
            elif e.code == 403:
                err_msg = "源站防盗链或拒绝访问 (HTTP 403 Forbidden)"
            elif e.code == 404:
                err_msg = "音频资源文件不存在 (HTTP 404 Not Found)"
            elif e.code == 503:
                err_msg = "源站服务过载不可用 (HTTP 503)"
            else:
                err_msg = f"源站 HTTP 请求失败 ({e.code})"
            logger.warning("HTTP error downloading episode %s: %s", episode_id, err_msg)
            self._record_failed(episode_id, row, err_msg, temp_path)
            return False
        except urllib.error.URLError as e:
            reason_str = str(e.reason)
            if "timed out" in reason_str.lower() or "timeout" in reason_str.lower():
                err_msg = "网络连接超时，源站响应过慢"
            elif "certificate" in reason_str.lower() or "ssl" in reason_str.lower():
                err_msg = "源站 SSL 证书校验失败"
            else:
                err_msg = f"网络连接失败 ({reason_str[:40]})"
            logger.warning("URL error downloading episode %s: %s", episode_id, err_msg)
            self._record_failed(episode_id, row, err_msg, temp_path)
            return False
        except TimeoutError:
            err_msg = "网络请求超时，源站响应过慢"
            logger.warning("Timeout downloading episode %s", episode_id)
            self._record_failed(episode_id, row, err_msg, temp_path)
            return False
        except Exception as e:
            err_msg = f"下载遇到异常: {str(e)[:60]}"
            logger.error("Failed downloading episode %s: %s", episode_id, e)
            self._record_failed(episode_id, row, err_msg, temp_path)
            return False

    def _record_failed(self, episode_id: str, row: Any, error_msg: str, temp_path: Path):
        if temp_path.exists():
            temp_path.unlink(missing_ok=True)
        try:
            with self.database.connect(write=True) as conn:
                conn.execute(
                    "UPDATE podcast_episodes SET download_status = 'failed' WHERE id = ?",
                    (episode_id,),
                )
        except Exception:
            # Best-effort database status update on download failure
            pass
        self._failed_downloads[episode_id] = {
            "episode_id": episode_id,
            "podcast_id": row["podcast_id"] if row else "",
            "episode_title": row["title"] if row else "单集",
            "podcast_title": row["podcast_title"] if row else "播客",
            "status": "failed",
            "error": error_msg,
            "failed_at": datetime.now(UTC).isoformat(),
        }

    def get_podcast_disk_usage(self, podcast_id: str) -> dict[str, Any]:
        with self.database.connect() as conn:
            p = conn.execute(
                "SELECT id, title FROM podcasts WHERE id = ?", (podcast_id,)
            ).fetchone()
            if not p:
                raise HTTPException(status_code=404, detail="播客未找到")
            podcast_title = p["title"]
            ep_rows = conn.execute(
                """
                SELECT COUNT(*) as total,
                       SUM(CASE WHEN download_status = 'downloaded' THEN 1 ELSE 0 END) as downloaded
                FROM podcast_episodes WHERE podcast_id = ?
                """,
                (podcast_id,),
            ).fetchone()

        folder_name = podcast_folder_name(podcast_id)
        podcast_dir = self._podcast_dir(podcast_id)
        with self.database.connect() as conn:
            raw_paths = [
                row["local_path"]
                for row in conn.execute(
                    "SELECT local_path FROM podcast_episodes WHERE podcast_id = ?",
                    (podcast_id,),
                ).fetchall()
            ]
        tracked_paths = {
            path for path in (self._safe_local_path(raw) for raw in raw_paths) if path is not None
        }
        total_bytes = 0
        for path in tracked_paths:
            try:
                if path.is_file():
                    total_bytes += path.stat().st_size
            except OSError:
                continue
        if podcast_dir.exists():
            for root, _, files in os.walk(podcast_dir):
                for filename in files:
                    path = (Path(root) / filename).resolve()
                    if path in tracked_paths:
                        continue
                    try:
                        total_bytes += path.stat().st_size
                    except OSError:
                        continue

        def human_size(n: int) -> str:
            for unit in ["B", "KB", "MB", "GB", "TB"]:
                if n < 1024.0:
                    return f"{n:.1f} {unit}"
                n /= 1024.0
            return f"{n:.1f} PB"

        return {
            "podcast_id": podcast_id,
            "podcast_title": podcast_title,
            "storage_path": str(podcast_dir),
            "relative_path": folder_name,
            "total_episodes": ep_rows["total"] or 0,
            "downloaded_episodes": ep_rows["downloaded"] or 0,
            "disk_usage_bytes": total_bytes,
            "disk_usage_human": human_size(total_bytes),
        }

    def clean_downloaded_files(self, podcast_id: str) -> dict[str, Any]:
        with self.database.connect() as conn:
            p = conn.execute(
                "SELECT id, title FROM podcasts WHERE id = ?", (podcast_id,)
            ).fetchone()
            if not p:
                raise HTTPException(status_code=404, detail="播客未找到")

        with self.database.connect() as conn:
            paths = [
                row["local_path"]
                for row in conn.execute(
                    "SELECT local_path FROM podcast_episodes WHERE podcast_id = ?",
                    (podcast_id,),
                ).fetchall()
            ]
            protected = [
                row["local_path"]
                for row in conn.execute(
                    "SELECT local_path FROM podcast_episodes WHERE podcast_id <> ?",
                    (podcast_id,),
                ).fetchall()
            ]
        freed_bytes = 0
        for path in (self._safe_local_path(raw) for raw in paths):
            try:
                if path is not None and path.is_file():
                    freed_bytes += path.stat().st_size
            except OSError:
                continue
        deleted_count = self._delete_local_paths(paths, protected=protected)

        with self.database.connect(write=True) as conn:
            conn.execute(
                "UPDATE podcast_episodes SET local_path = NULL, download_status = 'none' WHERE podcast_id = ?",
                (podcast_id,),
            )

        return {
            "status": "ok",
            "freed_bytes": freed_bytes,
            "deleted_count": deleted_count,
        }

    def _get_episode_display_info(self, episode_id: str) -> dict[str, Any] | None:
        try:
            with self.database.connect() as conn:
                row = conn.execute(
                    """
                    SELECT e.id, e.podcast_id, e.title, e.pub_date, e.episode_number,
                           e.duration_seconds, e.download_status, p.title as podcast_title, p.cover_url,
                           COALESCE(p.slow_download, 0) as slow_download,
                           COALESCE(p.max_retries, 3) as max_retries,
                           COALESCE(p.retry_backoff_base, 5) as retry_backoff_base
                    FROM podcast_episodes e
                    JOIN podcasts p ON p.id = e.podcast_id
                    WHERE e.id = ?
                    """,
                    (episode_id,),
                ).fetchone()
                if not row:
                    return None
                return {
                    "episode_id": row["id"],
                    "podcast_id": row["podcast_id"],
                    "episode_title": row["title"],
                    "podcast_title": row["podcast_title"],
                    "cover_url": row["cover_url"],
                    "pub_date": row["pub_date"],
                    "episode_number": row["episode_number"],
                    "duration_seconds": row["duration_seconds"],
                    "download_status": row["download_status"],
                    "slow_download": bool(row["slow_download"]),
                    "max_retries": int(row["max_retries"]),
                    "retry_backoff_base": int(row["retry_backoff_base"]),
                }
        except Exception:
            return None

    def queue_download_episode(self, episode_id: str) -> bool:
        self._cancelled_downloads.discard(episode_id)
        if episode_id in self._active_downloads or episode_id in self._queued_episodes:
            return False
        info = self._get_episode_display_info(episode_id)
        if not info:
            return False
        if info.get("download_status") == "downloaded":
            return False

        self._queued_episodes[episode_id] = {
            **info,
            "status": "queued",
            "enqueued_at": datetime.now(UTC).isoformat(),
        }
        self._download_queue.put(episode_id)
        return True

    def get_download_queue_info(self) -> dict[str, Any]:
        return {
            "active_count": len(self._active_downloads),
            "queued_count": len(self._queued_episodes),
            "failed_count": len(self._failed_downloads),
            "total_pending": len(self._active_downloads) + len(self._queued_episodes),
            "downloading": list(self._active_downloads.values()),
            "queued": list(self._queued_episodes.values()),
            "recent_completed": list(self._recent_completed),
            "failed": list(self._failed_downloads.values()),
        }

    def retry_all_failed(self) -> int:
        retried = 0
        failed_ids = list(self._failed_downloads.keys())
        for ep_id in failed_ids:
            self._failed_downloads.pop(ep_id, None)
            if self.queue_download_episode(ep_id):
                retried += 1
        return retried

    def clear_recent_completed(self) -> None:
        self._recent_completed.clear()

    def stream_remote_audio(self, audio_url: str, client_range: str | None = None):
        try:
            audio_url = validate_remote_url(audio_url)
        except PodcastURLRejected as exc:
            raise HTTPException(status_code=422, detail="invalid_podcast_audio_url") from exc
        proxy_mode, proxy_url = self.get_network_policy()
        headers = {"User-Agent": USER_AGENT}
        if client_range:
            headers["Range"] = client_range
        req = urllib.request.Request(audio_url, headers=headers)
        opener = podcast_opener(proxy_mode, proxy_url)

        try:
            resp = opener.open(req, timeout=15)  # nosec B310
        except Exception as e:
            logger.warning(
                "Remote audio stream proxy failed (%s): %s; redirecting client", audio_url, e
            )
            return RedirectResponse(url=audio_url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)

        status_code = resp.status if hasattr(resp, "status") else 200
        content_type = resp.headers.get("Content-Type") or "audio/mpeg"
        content_length = resp.headers.get("Content-Length")
        if content_length and content_length.isdigit() and int(content_length) > MAX_AUDIO_BYTES:
            resp.close()
            raise HTTPException(status_code=413, detail="podcast_audio_too_large")
        response_headers = {
            "Accept-Ranges": "bytes",
            "Content-Type": content_type,
        }
        for h in ("Content-Length", "Content-Range"):
            val = resp.headers.get(h)
            if val:
                response_headers[h] = val

        def iterfile():
            try:
                while True:
                    chunk = resp.read(64 * 1024)
                    if not chunk:
                        break
                    yield chunk
            finally:
                resp.close()

        return StreamingResponse(iterfile(), status_code=status_code, headers=response_headers)

    def list_podcasts(self, user_id: str) -> list[dict[str, Any]]:
        with self.database.connect() as conn:
            query = """
                SELECT
                    p.id, p.title, p.author, p.description, p.feed_url, p.cover_url,
                    p.auto_update, p.update_interval_minutes,
                    COALESCE(p.download_policy, 'latest_3') as download_policy,
                    COALESCE(p.retention_policy, 'keep') as retention_policy,
                    COALESCE(p.slow_download, 0) as slow_download,
                    COALESCE(p.max_retries, 3) as max_retries,
                    COALESCE(p.retry_backoff_base, 5) as retry_backoff_base,
                    p.last_updated_at, p.created_at,
                    COUNT(e.id) AS total_episodes,
                    SUM(CASE WHEN COALESCE(pr.completed, 0) = 0 THEN 1 ELSE 0 END) AS unplayed_episodes,
                    SUM(CASE WHEN e.download_status = 'downloaded' THEN 1 ELSE 0 END) AS downloaded_episodes
                FROM podcasts p
                LEFT JOIN podcast_episodes e ON e.podcast_id = p.id
                LEFT JOIN podcast_progress pr ON pr.episode_id = e.id AND pr.user_id = ?
                GROUP BY p.id
                ORDER BY p.created_at DESC
            """
            rows = conn.execute(query, (user_id,)).fetchall()
            return [
                {
                    "id": r["id"],
                    "title": r["title"],
                    "author": r["author"],
                    "description": r["description"],
                    "feed_url": r["feed_url"],
                    "cover_url": r["cover_url"],
                    "auto_update": bool(r["auto_update"]),
                    "update_interval_minutes": r["update_interval_minutes"],
                    "download_policy": r["download_policy"],
                    "retention_policy": r["retention_policy"],
                    "slow_download": bool(r["slow_download"]),
                    "max_retries": int(r["max_retries"]),
                    "retry_backoff_base": int(r["retry_backoff_base"]),
                    "last_updated_at": r["last_updated_at"],
                    "created_at": r["created_at"],
                    "total_episodes": r["total_episodes"] or 0,
                    "unplayed_episodes": r["unplayed_episodes"] or 0,
                    "downloaded_episodes": r["downloaded_episodes"] or 0,
                    "storage_path": podcast_folder_name(r["id"]),
                }
                for r in rows
            ]

    def get_podcast_detail(self, podcast_id: str, user_id: str) -> dict[str, Any]:
        with self.database.connect() as conn:
            p = conn.execute(
                """
                SELECT
                    p.id, p.title, p.author, p.description, p.feed_url, p.cover_url,
                    p.auto_update, p.update_interval_minutes,
                    COALESCE(p.download_policy, 'latest_3') as download_policy,
                    COALESCE(p.retention_policy, 'keep') as retention_policy,
                    COALESCE(p.slow_download, 0) as slow_download,
                    COALESCE(p.max_retries, 3) as max_retries,
                    COALESCE(p.retry_backoff_base, 5) as retry_backoff_base,
                    p.last_updated_at, p.created_at,
                    COUNT(e.id) AS total_episodes,
                    SUM(CASE WHEN COALESCE(pr.completed, 0) = 0 THEN 1 ELSE 0 END) AS unplayed_episodes,
                    SUM(CASE WHEN e.download_status = 'downloaded' THEN 1 ELSE 0 END) AS downloaded_episodes
                FROM podcasts p
                LEFT JOIN podcast_episodes e ON e.podcast_id = p.id
                LEFT JOIN podcast_progress pr ON pr.episode_id = e.id AND pr.user_id = ?
                WHERE p.id = ?
                GROUP BY p.id
                """,
                (user_id, podcast_id),
            ).fetchone()
            if not p:
                raise HTTPException(status_code=404, detail="播客未找到")

            ep_rows = conn.execute(
                """
                SELECT
                    e.id, e.podcast_id, e.guid, e.title, e.description, e.audio_url,
                    e.duration_seconds, e.pub_date, e.episode_number, e.season_number, e.created_at,
                    COALESCE(e.local_path, '') AS local_path,
                    COALESCE(e.download_status, 'none') AS download_status,
                    COALESCE(pr.position_seconds, 0) AS position_seconds,
                    COALESCE(pr.completed, 0) AS completed
                FROM podcast_episodes e
                LEFT JOIN podcast_progress pr ON pr.episode_id = e.id AND pr.user_id = ?
                WHERE e.podcast_id = ?
                ORDER BY e.created_at DESC
                """,
                (user_id, podcast_id),
            ).fetchall()

            def ep_sort_key(ep_row: Any) -> tuple[float, int, str]:
                pub_ts = 0.0
                pub_raw = ep_row["pub_date"] or ""
                if pub_raw:
                    try:
                        import email.utils

                        pub_ts = email.utils.parsedate_to_datetime(pub_raw).timestamp()
                    except Exception:
                        try:
                            from datetime import datetime

                            pub_ts = datetime.fromisoformat(pub_raw).timestamp()
                        except Exception:
                            pub_ts = 0.0
                ep_num = ep_row["episode_number"] or 0
                if not ep_num:
                    m = re.search(r"#(\d+)|第\s*(\d+)\s*期", ep_row["title"] or "")
                    if m:
                        try:
                            ep_num = int(m.group(1) or m.group(2) or 0)
                        except Exception:
                            ep_num = 0
                return (pub_ts, ep_num, ep_row["created_at"] or "")

            sorted_ep_rows = sorted(ep_rows, key=ep_sort_key, reverse=True)

            return {
                "podcast": {
                    "id": p["id"],
                    "title": p["title"],
                    "author": p["author"],
                    "description": p["description"],
                    "feed_url": p["feed_url"],
                    "cover_url": p["cover_url"],
                    "auto_update": bool(p["auto_update"]),
                    "update_interval_minutes": p["update_interval_minutes"],
                    "download_policy": p["download_policy"],
                    "retention_policy": p["retention_policy"],
                    "slow_download": bool(p["slow_download"]),
                    "max_retries": int(p["max_retries"]),
                    "retry_backoff_base": int(p["retry_backoff_base"]),
                    "last_updated_at": p["last_updated_at"],
                    "created_at": p["created_at"],
                    "total_episodes": p["total_episodes"] or 0,
                    "unplayed_episodes": p["unplayed_episodes"] or 0,
                    "downloaded_episodes": p["downloaded_episodes"] or 0,
                    "storage_path": podcast_folder_name(p["id"]),
                },
                "episodes": [
                    {
                        "id": ep["id"],
                        "podcast_id": ep["podcast_id"],
                        "guid": ep["guid"],
                        "title": ep["title"],
                        "description": ep["description"],
                        "audio_url": ep["audio_url"],
                        "duration_seconds": ep["duration_seconds"],
                        "pub_date": ep["pub_date"],
                        "episode_number": ep["episode_number"],
                        "season_number": ep["season_number"],
                        "created_at": ep["created_at"],
                        "position_seconds": ep["position_seconds"],
                        "completed": bool(ep["completed"]),
                        # Absolute host paths are internal state; stream endpoints resolve them server-side.
                        "local_path": None,
                        "download_status": ep["download_status"] or "none",
                    }
                    for ep in sorted_ep_rows
                ],
            }

    def delete_podcast(self, podcast_id: str) -> bool:
        with self.database.connect() as conn:
            p = conn.execute("SELECT id FROM podcasts WHERE id = ?", (podcast_id,)).fetchone()
            if not p:
                return False
            episode_rows = conn.execute(
                "SELECT id, local_path FROM podcast_episodes WHERE podcast_id = ?", (podcast_id,)
            ).fetchall()
            protected_paths = [
                row["local_path"]
                for row in conn.execute(
                    "SELECT local_path FROM podcast_episodes WHERE podcast_id <> ?",
                    (podcast_id,),
                ).fetchall()
            ]

        for row in episode_rows:
            self._cancelled_downloads.add(row["id"])
            self._queued_episodes.pop(row["id"], None)

        with self.database.connect(write=True) as conn:
            deleted = conn.execute("DELETE FROM podcasts WHERE id = ?", (podcast_id,)).rowcount

        self._delete_local_paths(
            [row["local_path"] for row in episode_rows], protected=protected_paths
        )
        if not any(row["id"] in self._active_downloads for row in episode_rows):
            shutil.rmtree(self._podcast_dir(podcast_id), ignore_errors=True)
        return deleted > 0

    def get_episode(
        self, episode_id: str, user_id: str, *, include_local_path: bool = False
    ) -> dict[str, Any] | None:
        with self.database.connect() as conn:
            row = conn.execute(
                """
                SELECT
                    e.id, e.podcast_id, e.guid, e.title, e.description, e.audio_url,
                    e.duration_seconds, e.pub_date, e.episode_number, e.season_number, e.created_at,
                    COALESCE(e.local_path, '') AS local_path,
                    COALESCE(e.download_status, 'none') AS download_status,
                    COALESCE(pr.position_seconds, 0) AS position_seconds,
                    COALESCE(pr.completed, 0) AS completed
                FROM podcast_episodes e
                LEFT JOIN podcast_progress pr ON pr.episode_id = e.id AND pr.user_id = ?
                WHERE e.id = ?
                """,
                (user_id, episode_id),
            ).fetchone()
            if not row:
                return None
            return {
                "id": row["id"],
                "podcast_id": row["podcast_id"],
                "guid": row["guid"],
                "title": row["title"],
                "description": row["description"],
                "audio_url": row["audio_url"],
                "duration_seconds": row["duration_seconds"],
                "pub_date": row["pub_date"],
                "episode_number": row["episode_number"],
                "season_number": row["season_number"],
                "created_at": row["created_at"],
                "position_seconds": row["position_seconds"],
                "completed": bool(row["completed"]),
                "local_path": row["local_path"] if include_local_path else None,
                "download_status": row["download_status"] or "none",
            }

    def update_progress(
        self,
        user_id: str,
        episode_id: str,
        position_seconds: int,
        duration_seconds: int,
        completed: bool,
    ) -> None:
        local_path: str | None = None
        protected_paths: list[str | None] = []
        remove_after_play = False
        with self.database.connect(write=True) as conn:
            episode = conn.execute(
                """
                SELECT e.local_path, COALESCE(p.retention_policy, 'keep') AS retention_policy
                FROM podcast_episodes e
                JOIN podcasts p ON p.id = e.podcast_id
                WHERE e.id = ?
                """,
                (episode_id,),
            ).fetchone()
            if not episode:
                raise HTTPException(status_code=404, detail="单集未找到")
            local_path = episode["local_path"]
            remove_after_play = completed and episode["retention_policy"] == "delete_after_played"
            if remove_after_play:
                protected_paths = [
                    row["local_path"]
                    for row in conn.execute(
                        "SELECT local_path FROM podcast_episodes WHERE id <> ?",
                        (episode_id,),
                    ).fetchall()
                ]
            conn.execute(
                """
                INSERT INTO podcast_progress (
                    user_id, episode_id, position_seconds, duration_seconds, completed, last_listened_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id, episode_id) DO UPDATE SET
                    position_seconds = excluded.position_seconds,
                    duration_seconds = excluded.duration_seconds,
                    completed = excluded.completed,
                    last_listened_at = excluded.last_listened_at
                """,
                (
                    user_id,
                    episode_id,
                    position_seconds,
                    duration_seconds,
                    1 if completed else 0,
                    now(),
                ),
            )
            if remove_after_play:
                conn.execute(
                    "UPDATE podcast_episodes SET local_path = NULL, download_status = 'none' WHERE id = ?",
                    (episode_id,),
                )
        if remove_after_play:
            self._delete_local_paths([local_path], protected=protected_paths)


def podcast_router(manager: PodcastManager, auth: Auth) -> APIRouter:
    router = APIRouter(prefix="/api/v1/podcasts", tags=["podcasts"])

    @router.get("", response_model=list[PodcastSummaryResponse])
    def list_podcasts(user: Annotated[dict, Depends(auth.require_session)]):
        return manager.list_podcasts(user["id"])

    @router.post(
        "",
        response_model=PodcastDetailResponse,
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("library:manage")),
        ],
    )
    def subscribe_podcast(
        payload: PodcastCreateRequest,
        user: Annotated[dict, Depends(auth.require_session)],
    ):
        return manager.subscribe(
            feed_url=payload.feed_url,
            auto_update=payload.auto_update,
            update_interval_minutes=payload.update_interval_minutes,
            download_policy=payload.download_policy,
            retention_policy=payload.retention_policy,
            slow_download=payload.slow_download,
            max_retries=payload.max_retries,
            retry_backoff_base=payload.retry_backoff_base,
        )

    @router.put(
        "/{podcast_id}/settings",
        response_model=PodcastDetailResponse,
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("library:manage")),
        ],
    )
    def update_settings(
        podcast_id: str,
        payload: PodcastUpdateRequest,
        user: Annotated[dict, Depends(auth.require_session)],
    ):
        manager.update_podcast(
            podcast_id=podcast_id,
            title=payload.title,
            auto_update=payload.auto_update,
            update_interval_minutes=payload.update_interval_minutes,
            download_policy=payload.download_policy,
            retention_policy=payload.retention_policy,
            slow_download=payload.slow_download,
            max_retries=payload.max_retries,
            retry_backoff_base=payload.retry_backoff_base,
        )
        return manager.get_podcast_detail(podcast_id, user["id"])

    @router.get(
        "/{podcast_id}/storage",
        response_model=PodcastStorageResponse,
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("library:manage")),
        ],
    )
    def get_podcast_storage(
        podcast_id: str,
        user: Annotated[dict, Depends(auth.require_session)],
    ):
        return manager.get_podcast_disk_usage(podcast_id)

    @router.post(
        "/{podcast_id}/clean-downloads",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("library:manage")),
        ],
    )
    def clean_podcast_downloads(
        podcast_id: str,
        user: Annotated[dict, Depends(auth.require_session)],
    ):
        return manager.clean_downloaded_files(podcast_id)

    @router.post(
        "/{podcast_id}/download-all",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("library:manage")),
        ],
    )
    def download_all_episodes(
        podcast_id: str,
        user: Annotated[dict, Depends(auth.require_session)],
        slow_download: bool | None = None,
    ):
        if slow_download is not None:
            manager.update_podcast(podcast_id, slow_download=slow_download)
        queued = manager._auto_download_by_policy(podcast_id, "all")
        return {
            "status": "queued",
            "id": podcast_id,
            "queued_episodes": queued,
            "message": f"已将 {queued} 集加入下载队列",
        }

    @router.post(
        "/refresh-all",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("library:manage")),
        ],
    )
    def refresh_all(user: Annotated[dict, Depends(auth.require_session)]):
        count = manager.run_scheduled_updates()
        return {"refreshed_count": count}

    @router.get(
        "/downloads/queue",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("library:manage")),
        ],
    )
    def get_download_queue():
        return manager.get_download_queue_info()

    @router.post(
        "/downloads/retry-failed",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("library:manage")),
        ],
    )
    def retry_failed_downloads():
        retried = manager.retry_all_failed()
        return {"status": "ok", "retried_count": retried}

    @router.post(
        "/downloads/clear-completed",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("library:manage")),
        ],
    )
    def clear_completed_downloads():
        manager.clear_recent_completed()
        return {"status": "ok"}

    @router.get("/{podcast_id}", response_model=PodcastDetailResponse)
    def get_podcast(
        podcast_id: str,
        user: Annotated[dict, Depends(auth.require_session)],
    ):
        return manager.get_podcast_detail(podcast_id, user["id"])

    @router.post(
        "/{podcast_id}/refresh",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("library:manage")),
        ],
    )
    def refresh_podcast(
        podcast_id: str,
        user: Annotated[dict, Depends(auth.require_session)],
    ):
        manager.refresh_podcast(podcast_id)
        return manager.get_podcast_detail(podcast_id, user["id"])

    @router.delete(
        "/{podcast_id}",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("library:manage")),
        ],
    )
    def delete_podcast(
        podcast_id: str,
        user: Annotated[dict, Depends(auth.require_session)],
    ):
        ok = manager.delete_podcast(podcast_id)
        if not ok:
            raise HTTPException(status_code=404, detail="播客未找到")
        return {"status": "deleted", "id": podcast_id}

    @router.get("/episodes/{episode_id}", response_model=PodcastEpisodeResponse)
    def get_episode(
        episode_id: str,
        user: Annotated[dict, Depends(auth.require_session)],
    ):
        ep = manager.get_episode(episode_id, user["id"])
        if not ep:
            raise HTTPException(status_code=404, detail="单集未找到")
        return ep

    @router.get("/episodes/{episode_id}/stream")
    def stream_episode(
        episode_id: str,
        request: Request,
        user: Annotated[dict, Depends(auth.require_session)],
    ):
        ep = manager.get_episode(episode_id, user["id"], include_local_path=True)
        if not ep or not ep.get("audio_url"):
            raise HTTPException(status_code=404, detail="音频不可用")
        local_path = manager._safe_local_path(ep.get("local_path"))
        if local_path and local_path.is_file():
            return FileResponse(local_path, media_type="audio/mpeg")
        if request.query_params.get("proxy") == "1":
            return manager.stream_remote_audio(ep["audio_url"], request.headers.get("range"))
        return RedirectResponse(url=ep["audio_url"], status_code=status.HTTP_307_TEMPORARY_REDIRECT)

    @router.post(
        "/episodes/{episode_id}/download",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("library:manage")),
        ],
    )
    def download_episode(
        episode_id: str,
        user: Annotated[dict, Depends(auth.require_session)],
    ):
        ep = manager.get_episode(episode_id, user["id"])
        if not ep:
            raise HTTPException(status_code=404, detail="单集未找到")
        manager.queue_download_episode(episode_id)
        return {"status": "downloading", "id": episode_id}

    @router.put("/episodes/{episode_id}/progress", dependencies=[Depends(auth.require_client)])
    def update_progress(
        episode_id: str,
        payload: PodcastProgressRequest,
        user: Annotated[dict, Depends(auth.require_session)],
    ):
        manager.update_progress(
            user_id=user["id"],
            episode_id=episode_id,
            position_seconds=payload.position_seconds,
            duration_seconds=payload.duration_seconds,
            completed=payload.completed,
        )
        return {"status": "ok"}

    return router
