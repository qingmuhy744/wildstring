"""OPML import previews first, adds per feed through the normal path and exports follows."""

import pytest
import test_podcast_search as search_support
from fastapi import HTTPException
from fastapi.testclient import TestClient

from wildstring.podcast_opml import build_opml, parse_opml

FIRESIDE = search_support.FIRESIDE
HEADERS = search_support.HEADERS
# Reuse the recorded iTunes and feed fakes from the search tests.
itunes = search_support.itunes
feeds = search_support.feeds

OPML = """<?xml version="1.0" encoding="utf-8"?>
<opml version="2.0">
  <head><title>Exported</title></head>
  <body>
    <outline text="中文播客">
      <outline type="rss" text="声东击西" xmlUrl="https://etw.fm/rss" htmlUrl="https://etw.fm"/>
      <outline type="rss" text="声东击西 again" xmlUrl="HTTPS://ETW.FM/rss/"/>
      <outline type="rss" text="Fireside" xmlUrl="https://feeds.fireside.fm/shengdongjixi/rss"/>
    </outline>
    <outline type="rss" text="Broken" xmlUrl="https://broken.example.com/feed"/>
    <outline type="rss" text="FTP" xmlUrl="ftp://example.com/feed"/>
    <outline type="link" text="Just a link" url="https://example.com"/>
  </body>
</opml>"""


def parse(client, content):
    return client.post("/api/v1/podcasts/opml/parse", headers=HEADERS, json={"content": content})


def run_import(client, *urls):
    return client.post(
        "/api/v1/podcasts/opml/import",
        headers=HEADERS,
        json={"feeds": [{"feed_url": url} for url in urls]},
    )


def test_parse_dedupes_counts_invalid_and_ignores_plain_links():
    parsed = parse_opml(OPML)
    assert [item["feed_url"] for item in parsed["feeds"]] == [
        "https://etw.fm/rss",
        FIRESIDE,
        "https://broken.example.com/feed",
    ]
    assert parsed["duplicates"] == 1 and parsed["invalid"] == 1
    assert parsed["feeds"][0]["title"] == "声东击西"


def test_parse_rejects_entities_wrong_roots_and_empty_documents(settings, authenticated_client):
    laughs = (
        '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">]>'
        '<opml><body><outline xmlUrl="https://a.example/&lol;"/></body></opml>'
    )
    with authenticated_client(settings) as client:
        assert parse(client, laughs).json()["detail"] == "podcast_opml_invalid"
        assert parse(client, "<rss><channel/></rss>").json()["detail"] == "podcast_opml_invalid"
        assert parse(client, "not xml").status_code == 422
        empty = parse(client, "<opml><body><outline text='x'/></body></opml>")
        assert empty.status_code == 422 and empty.json()["detail"] == "podcast_opml_empty"


@pytest.mark.parametrize(
    "declaration",
    [
        '<!DOCTYPE opml [<!ENTITY first "expanded"><!ENTITY second "&first;&first;">]>',
        '<!DOCTYPE opml [<!ENTITY second SYSTEM "file:///etc/passwd">]>',
        '<!DOCTYPE opml [<!ENTITY % remote SYSTEM "https://example.com/evil.dtd">%remote;]>',
        '<!DOCTYPE opml SYSTEM "https://example.com/evil.dtd">',
    ],
    ids=["nested-entity", "local-file-entity", "remote-parameter-entity", "external-dtd"],
)
@pytest.mark.parametrize("encoding", ["utf-8", "utf-16le"])
def test_parse_rejects_dtds_including_null_interleaved_input(declaration, encoding):
    document = (
        f'<?xml version="1.0" encoding="{encoding}"?>{declaration}'
        '<opml><body><outline xmlUrl="https://example.com/feed" text="&second;"/></body></opml>'
    )
    # ASCII UTF-16LE bytes also form a valid JSON string with interleaved NULs.
    # A byte regex for DOCTYPE misses it, while Expat still recognises the XML.
    content = document.encode(encoding).decode("utf-8")
    with pytest.raises(HTTPException) as rejected:
        parse_opml(content)
    assert rejected.value.status_code == 422
    assert rejected.value.detail == "podcast_opml_invalid"


def test_parse_allows_comments_and_predefined_entities():
    parsed = parse_opml(
        "<opml><!-- An example of a declaration: <!DOCTYPE opml> -->"
        '<body><outline text="Arts &amp; Music" '
        'xmlUrl="https://example.com/feed?a=1&amp;b=2"/></body></opml>'
    )
    assert parsed["feeds"][0]["title"] == "Arts & Music"
    assert parsed["feeds"][0]["feed_url"] == "https://example.com/feed?a=1&b=2"


def test_parse_marks_catalog_state_without_adding(settings, authenticated_client, itunes, feeds):
    with authenticated_client(settings) as client:
        assert (
            client.post(
                "/api/v1/podcasts", headers=HEADERS, json={"feed_url": FIRESIDE}
            ).status_code
            == 200
        )
        fetched = len(feeds)
        response = parse(client, OPML)
        assert response.status_code == 200, response.text
        body = response.json()
        state = {item["feed_url"]: item for item in body["feeds"]}
        assert state[FIRESIDE]["in_catalog"] and state[FIRESIDE]["followed"]
        assert state["https://broken.example.com/feed"]["in_catalog"] is False
        assert all(not key.startswith("_") for item in body["feeds"] for key in item)
        assert len(feeds) == fetched
        assert len(client.get("/api/v1/podcasts").json()) == 1


def test_import_reports_each_feed_and_dedupes(settings, authenticated_client, itunes, feeds):
    with authenticated_client(settings) as client:
        first = client.post("/api/v1/podcasts", headers=HEADERS, json={"feed_url": FIRESIDE})
        existing = first.json()["podcast"]["id"]
        response = run_import(
            client,
            "https://etw.fm/rss",
            "https://new.example.com/feed.xml",
            "https://broken.example.com/feed",
        )
        assert response.status_code == 200, response.text
        results = response.json()["results"]
        assert [item["status"] for item in results] == ["already_followed", "added", "failed"]
        assert results[0]["podcast_id"] == existing
        assert results[2]["code"] == "podcast_feed_fetch_failed"

        client.put(f"/api/v1/podcasts/{existing}/follow", headers=HEADERS, json={"followed": False})
        again = run_import(client, FIRESIDE).json()["results"]
        assert again == [
            {
                "feed_url": FIRESIDE,
                "status": "followed",
                "podcast_id": existing,
                "title": "声东击西",
            }
        ]
        assert len(client.get("/api/v1/podcasts").json()) == 2


def test_import_is_bounded_and_follows_add_policy(settings, authenticated_client, itunes, feeds):
    with authenticated_client(settings) as client:
        too_many = run_import(client, *[f"https://x{i}.example.com/feed" for i in range(11)])
        assert too_many.status_code == 422
        created = client.post(
            "/api/v1/manage/users",
            headers=HEADERS,
            json={"username": "opml", "password": "listener-password-1", "library_ids": []},
        )
        assert created.status_code == 201
        listener = TestClient(client.app)
        try:
            listener.post(
                "/api/v1/auth/login",
                headers=HEADERS,
                json={"username": "opml", "password": "listener-password-1"},
            )
            assert parse(listener, OPML).status_code == 200
            denied = run_import(listener, FIRESIDE)
            assert denied.status_code == 403
            assert denied.json()["detail"] == "podcast_subscriptions_disabled"
            assert feeds == []
        finally:
            listener.close()


def test_export_lists_only_followed_shows_and_round_trips(
    settings, authenticated_client, itunes, feeds, monkeypatch
):
    import wildstring.podcasts as podcasts

    real = podcasts.fetch_and_parse_feed

    def titled(url, **kwargs):
        result = real(url, **kwargs)
        if "tricky" in url:
            result["title"] = 'A & B <"special">'
        return result

    monkeypatch.setattr(podcasts, "fetch_and_parse_feed", titled)
    with authenticated_client(settings) as client:
        keep = client.post(
            "/api/v1/podcasts", headers=HEADERS, json={"feed_url": "https://tricky.example.com/f"}
        ).json()
        drop = client.post("/api/v1/podcasts", headers=HEADERS, json={"feed_url": FIRESIDE}).json()
        client.put(
            f"/api/v1/podcasts/{drop['podcast']['id']}/follow",
            headers=HEADERS,
            json={"followed": False},
        )
        response = client.get("/api/v1/podcasts/opml/export")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/x-opml")
        assert "attachment" in response.headers["content-disposition"]
        parsed = parse_opml(response.text)
        assert [(item["title"], item["feed_url"]) for item in parsed["feeds"]] == [
            ('A & B <"special">', keep["podcast"]["feed_url"])
        ]


def test_build_opml_is_valid_for_an_empty_follow_list():
    document = build_opml([]).decode()
    assert document.startswith("<?xml") and "<body" in document
