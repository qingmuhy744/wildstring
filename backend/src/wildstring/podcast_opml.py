"""OPML import and export for personal podcast follows.

Import is two steps: parse (no side effects) and import of selected feeds in small
batches through the same add-and-follow path as the add dialog, so catalog policy,
network policy, SSRF checks and dedupe all apply per feed.
"""

import logging
import xml.etree.ElementTree as ET  # nosec B405 - only used to build XML, never parse it
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Annotated, Any

from defusedxml import ElementTree as SafeET
from defusedxml.common import DefusedXmlException
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field

from wildstring.podcast_identity import normalize_feed_url

logger = logging.getLogger(__name__)

MAX_OPML_BYTES = 1_000_000
MAX_OPML_FEEDS = 1000
MAX_IMPORT_BATCH = 10


class OpmlParseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: str = Field(min_length=1, max_length=MAX_OPML_BYTES)


class OpmlImportItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    feed_url: str = Field(min_length=5, max_length=1024)


class OpmlImportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    feeds: list[OpmlImportItem] = Field(min_length=1, max_length=MAX_IMPORT_BATCH)


def _local(tag: Any) -> str:
    return str(tag).rsplit("}", 1)[-1].lower() if isinstance(tag, str) else ""


def parse_opml(content: str) -> dict[str, Any]:
    data = content.encode("utf-8")
    if len(data) > MAX_OPML_BYTES:
        raise HTTPException(413, "podcast_opml_too_large")
    try:
        root = SafeET.fromstring(data, forbid_dtd=True)
    except (ET.ParseError, DefusedXmlException):
        raise HTTPException(422, "podcast_opml_invalid") from None
    if _local(root.tag) != "opml":
        raise HTTPException(422, "podcast_opml_invalid")
    feeds: list[dict[str, str]] = []
    seen: set[str] = set()
    invalid = duplicates = 0
    for node in root.iter():
        if _local(node.tag) != "outline":
            continue
        attrs = {key.lower(): (value or "").strip() for key, value in node.attrib.items()}
        url = attrs.get("xmlurl") or (attrs.get("url") if attrs.get("type") == "rss" else "")
        if not url:
            continue
        key = normalize_feed_url(url)
        if not key:
            invalid += 1
            continue
        if key in seen:
            duplicates += 1
            continue
        seen.add(key)
        if len(feeds) >= MAX_OPML_FEEDS:
            raise HTTPException(413, "podcast_opml_too_many")
        feeds.append(
            {
                "feed_url": url,
                "title": (attrs.get("text") or attrs.get("title") or url)[:500],
                "html_url": attrs.get("htmlurl", "")[:2048],
                "_key": key,
            }
        )
    if not feeds:
        raise HTTPException(422, "podcast_opml_empty")
    return {"feeds": feeds, "invalid": invalid, "duplicates": duplicates}


def build_opml(rows: list[dict[str, Any]], *, now: datetime | None = None) -> bytes:
    stamp = (now or datetime.now(UTC)).strftime("%a, %d %b %Y %H:%M:%S GMT")
    root = ET.Element("opml", version="2.0")
    head = ET.SubElement(root, "head")
    ET.SubElement(head, "title").text = "WildString 播客关注"
    ET.SubElement(head, "dateCreated").text = stamp
    body = ET.SubElement(root, "body")
    for row in rows:
        ET.SubElement(
            body,
            "outline",
            type="rss",
            text=row["title"],
            title=row["title"],
            xmlUrl=row["feed_url"],
        )
    ET.indent(root)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True) + b"\n"


def routes(
    router: APIRouter,
    auth,
    *,
    database,
    annotate: Callable[[str, list[dict[str, Any]]], list[dict[str, Any]]],
    add_and_follow: Callable[[dict, str], dict],
    require_add: Callable[[dict], None],
) -> None:
    @router.post("/opml/parse", dependencies=[Depends(auth.require_client)])
    def parse(body: OpmlParseRequest, user: Annotated[dict, Depends(auth.require_session)]):
        parsed = parse_opml(body.content)
        items = [{**item, "_ids": set()} for item in parsed["feeds"]]
        return {
            "feeds": annotate(user["id"], items),
            "invalid": parsed["invalid"],
            "duplicates": parsed["duplicates"],
        }

    @router.post("/opml/import", dependencies=[Depends(auth.require_client)])
    def import_feeds(body: OpmlImportRequest, user: Annotated[dict, Depends(auth.require_session)]):
        require_add(user)
        with database.connect() as db:
            before = {
                row[0]
                for row in db.execute(
                    "SELECT podcast_id FROM podcast_follows WHERE user_id=?", (user["id"],)
                )
            }
            known = {row[0] for row in db.execute("SELECT id FROM podcasts")}
        results = []
        for item in body.feeds:
            try:
                detail = add_and_follow(user, item.feed_url)
            except HTTPException as exc:
                detail = exc.detail
                code = detail if isinstance(detail, str) else (detail or {}).get("code")
                results.append(
                    {
                        "feed_url": item.feed_url,
                        "status": "failed",
                        "code": code or "podcast_opml_feed_failed",
                    }
                )
                continue
            except Exception:  # one broken feed must not abort the rest of the batch
                logger.exception("OPML import failed for one feed")
                results.append(
                    {
                        "feed_url": item.feed_url,
                        "status": "failed",
                        "code": "podcast_opml_feed_failed",
                    }
                )
                continue
            podcast = detail["podcast"]
            status = (
                "already_followed"
                if podcast["id"] in before
                else "added"
                if podcast["id"] not in known
                else "followed"
            )
            results.append(
                {
                    "feed_url": item.feed_url,
                    "status": status,
                    "podcast_id": podcast["id"],
                    "title": podcast["title"],
                }
            )
        return {"results": results}

    @router.get("/opml/export")
    def export(user: Annotated[dict, Depends(auth.require_session)]):
        with database.connect() as db:
            rows = [
                dict(row)
                for row in db.execute(
                    "SELECT p.title,p.feed_url FROM podcast_follows f "
                    "JOIN podcasts p ON p.id=f.podcast_id WHERE f.user_id=? "
                    "ORDER BY p.title COLLATE NOCASE, p.id",
                    (user["id"],),
                )
            ]
        return Response(
            build_opml(rows),
            media_type="text/x-opml; charset=utf-8",
            headers={
                "Content-Disposition": 'attachment; filename="wildstring-podcasts.opml"',
                "Cache-Control": "no-store",
            },
        )
