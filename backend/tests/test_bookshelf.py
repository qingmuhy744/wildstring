"""Book libraries share the server's storage boundary and use separate grants."""

import json
from pathlib import Path

from fastapi.testclient import TestClient
from test_multiple_libraries import HEADERS, listener

from wildstring.database import Database


def create_library(client, name, **fields):
    response = client.post("/api/v1/book-libraries", headers=HEADERS, json={"name": name, **fields})
    assert response.status_code == 201, response.text
    return response.json()


def test_book_library_sources_have_one_row_per_directory(settings, authenticated_client, tmp_path):
    sources = [tmp_path / "source-one", tmp_path / "source-two"]
    for source in sources:
        source.mkdir()
    custom = tmp_path / "custom-books"
    with authenticated_client(settings) as client:
        created = create_library(client, "Reading", source_roots=list(map(str, sources)))
        assert Path(created["managed_root"]) == settings.data_dir / "books" / created["id"]
        assert Path(created["managed_root"]).is_dir()
        shared = create_library(client, "Shared", managed_root=str(custom), default_access="all")
        assert shared["managed_root"] == str(custom)
        assert custom.is_dir()

    with Database(settings.data_dir).connect() as db:
        registered = db.execute(
            "SELECT root, watch_enabled FROM book_library_sources WHERE library_id=? ORDER BY root",
            (created["id"],),
        )
        assert [tuple(row) for row in registered] == [(str(path), 1) for path in sources]
        assert db.execute(
            "SELECT storage_mode, default_access FROM book_libraries WHERE id=?",
            (created["id"],),
        ).fetchone()[:] == ("copy", "restricted")
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_restricted_books_require_a_book_grant_and_hide_paths(settings, authenticated_client):
    with authenticated_client(settings) as owner:
        private = create_library(owner, "Private")
        public = create_library(owner, "Public", default_access="all")
        library_id = private["id"]
        music = owner.get("/api/v1/libraries").json()[0]["id"]
        reader, user_id = listener(owner, [music])
        with Database(settings.data_dir).connect(write=True) as db:
            db.executemany(
                """INSERT INTO books(id,library_id,managed_dir,title,sort_title,created_at,updated_at)
                VALUES (?,?,?,?,?,1,1)""",
                [
                    ("private-book", library_id, "private-local-path", "Private", "Private"),
                    ("public-book", public["id"], "public-local-path", "Public", "Public"),
                ],
            )

        assert TestClient(owner.app).get("/api/v1/books").status_code == 401
        assert owner.get("/api/v1/books/private-book").status_code == 200
        assert reader.get("/api/v1/book-libraries").json()["items"][0]["id"] == public["id"]
        assert reader.get("/api/v1/books").json()["items"][0]["id"] == "public-book"
        denied = reader.get("/api/v1/books/private-book")
        missing = reader.get("/api/v1/books/missing")
        assert denied.status_code == missing.status_code == 404
        assert denied.json() == missing.json()
        assert reader.get("/api/v1/books", params={"library_id": library_id}).status_code == 404
        grant = f"/api/v1/book-libraries/{library_id}/access/{user_id}"
        assert reader.put(grant, headers=HEADERS, json={"granted": True}).status_code == 403
        assert owner.put(grant, headers=HEADERS, json={"granted": True}).status_code == 200

        response = reader.get(
            "/api/v1/books/private-book", headers={"X-Wildstring-Library": "missing-music-library"}
        )
        assert response.status_code == 200
        assert response.json() == {
            "id": "private-book",
            "library_id": library_id,
            "title": "Private",
            "subtitle": None,
            "authors": [],
            "has_cover": False,
            "has_ebook": False,
            "has_audiobook": False,
        }
        assert owner.put(grant, headers=HEADERS, json={"granted": False}).status_code == 200
        assert reader.get("/api/v1/books/private-book").status_code == 404


def test_book_and_music_storage_boundaries_include_migration_reservations(
    settings, authenticated_client, tmp_path
):
    music_source = settings.music_dir
    music_source.mkdir()
    book_source = tmp_path / "book-source"
    book_source.mkdir()
    empty_child = book_source / "empty"
    empty_child.mkdir()
    music_extra = tmp_path / "new-music-source"
    music_extra.mkdir()
    reserved_target = tmp_path / "reserved-by-book-migration"
    reserved_target.mkdir()
    book_endpoint = "/api/v1/book-libraries"
    music_endpoint = "/api/v1/libraries"

    with authenticated_client(settings) as client:
        book = create_library(client, "Reading", source_roots=[str(book_source)])
        with Database(settings.data_dir).connect(write=True) as db:
            db.execute(
                """INSERT INTO book_library_migrations
                   (id,library_id,source_root,target_root,library_version,created_by,created_at,updated_at)
                   VALUES ('book-move',?,?,?,1,'admin',1,1)""",
                (book["id"], book["managed_root"], str(reserved_target)),
            )

        book_into_music = client.post(
            book_endpoint, headers=HEADERS, json={"name": "Bad", "managed_root": str(music_source)}
        )
        assert book_into_music.status_code == 422
        assert book_into_music.json()["detail"] == "library_target_invalid"
        source_into_music = client.post(
            book_endpoint,
            headers=HEADERS,
            json={"name": "Bad", "source_roots": [str(music_source)]},
        )
        assert source_into_music.status_code == 422
        assert source_into_music.json()["detail"] == "library_sources_overlap"
        for target in (empty_child, reserved_target):
            music_into_books = client.post(
                music_endpoint,
                headers=HEADERS,
                json={
                    "name": "Bad",
                    "source_roots": [str(music_extra)],
                    "managed_root": str(target),
                },
            )
            assert music_into_books.status_code == 422
            assert music_into_books.json()["detail"] == "library_target_invalid"
        music_source_into_books = client.post(
            music_endpoint,
            headers=HEADERS,
            json={"name": "Bad", "source_roots": [str(book_source)]},
        )
        assert music_source_into_books.status_code == 422
        assert music_source_into_books.json()["detail"] == "library_sources_overlap"
        write_into_source = client.post(
            music_endpoint + "/folders",
            headers=HEADERS,
            json={"parent_path": str(book_source), "name": "should-not-exist"},
        )
        assert write_into_source.status_code == 403
        assert write_into_source.json()["detail"] == "folder_source_read_only"
        assert not (book_source / "should-not-exist").exists()


def test_upload_scanning_portable_metadata_and_personal_checkpoints(
    settings, authenticated_client, tmp_path
):
    source = tmp_path / "book-source"
    source.mkdir()
    original = source / "Scanner.txt"
    original.write_text("第一章\n来自扫描的正文")
    with authenticated_client(settings) as owner:
        library = create_library(
            owner,
            "Shared",
            source_roots=[str(source)],
            default_access="all",
            storage_mode="hardlink",
        )
        library_id = library["id"]
        scan = owner.post(f"/api/v1/book-libraries/{library_id}/scan", headers=HEADERS)
        assert scan.status_code == 200, scan.text
        assert scan.json()["added_books"] == 1, scan.text
        scanned = owner.get("/api/v1/books").json()["items"][0]
        with Database(settings.data_dir).connect() as db:
            record = db.execute(
                "SELECT * FROM book_ebooks WHERE book_id=?", (scanned["id"],)
            ).fetchone()
        assert record["link_mode"] == "hardlink"
        assert (
            original.stat().st_ino
            == (Path(library["managed_root"]) / record["managed_path"]).stat().st_ino
        )

        denied = owner.post(
            "/api/v1/books/upload",
            headers=HEADERS,
            data={"library_id": library_id},
            files={"file": ("masked.txt", b"ID3masked", "text/plain")},
        )
        assert denied.status_code == 422
        assert denied.json()["detail"] == "audio_upload_forbidden"
        response = owner.post(
            "/api/v1/books/upload",
            headers=HEADERS,
            data={"library_id": library_id},
            files={"file": ("Reader.txt", "第一章\n听见野弦".encode(), "text/plain")},
        )
        assert response.status_code == 201, response.text
        identity = response.json()["id"]
        prefix = f"/api/v1/books/{identity}"
        manifest = owner.get(prefix + "/ebook/manifest").json()
        assert manifest["chapters"][0]["title"] == "第一章"
        assert (
            owner.get(prefix + "/ebook/search", params={"q": "野弦"}).json()["items"][0][
                "char_offset"
            ]
            == 2
        )
        assert (
            owner.get(prefix + "/ebook/download", headers={"Range": "bytes=0-2"}).status_code == 206
        )
        changed = owner.patch(prefix + "/metadata", headers=HEADERS, json={"title": "精选野弦"})
        assert changed.status_code == 200, changed.text

        reader, _ = listener(owner, [])
        progress = prefix + "/reading-progress"
        body = {
            "device_id": "device",
            "session_id": "reading-session-00001",
            "base_version": 0,
            "sequence": 1,
            "spine_index": 0,
            "block_index": 1,
            "char_offset": 2,
        }
        assert owner.put(progress, headers=HEADERS, json=body).json()["version"] == 1
        conflict = owner.put(
            progress, headers=HEADERS, json=body | {"session_id": "reading-session-00002"}
        )
        assert conflict.status_code == 409
        assert reader.get(progress).json()["version"] == 0
        assert owner.get("/api/v1/books").json()["items"][0]["resume_kind"] == "reading"
        reader_book = next(
            book for book in reader.get("/api/v1/books").json()["items"] if book["id"] == identity
        )
        assert reader_book["resume_kind"] is None
        assert reader_book["progress_status"] == "unread"
        mark = owner.post(
            prefix + "/bookmarks",
            headers=HEADERS,
            json={
                "kind": "ebook",
                "spine_index": 0,
                "block_index": 1,
                "char_offset": 2,
                "note": "only the owner sees this",
            },
        )
        assert mark.status_code == 201, mark.text
        assert reader.get(prefix + "/bookmarks").json() == {"items": []}
        export = owner.post(f"/api/v1/book-libraries/{library_id}/export-sidecars", headers=HEADERS)
        assert export.json()["sidecars_written"] == 2, export.text
        path = Path(library["managed_root"]) / identity / ".wildstring" / "manifest.json"
        manifest_text = path.read_text()
        assert "精选野弦" in manifest_text
        assert "only the owner sees this" not in manifest_text
        assert "session_id" not in manifest_text and "user_id" not in manifest_text


def sample_epub(with_audio=False):
    from io import BytesIO
    from zipfile import ZipFile

    buffer = BytesIO()
    with ZipFile(buffer, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>',
        )
        archive.writestr(
            "OEBPS/book.opf",
            "<package><metadata><title>Portable EPUB</title><creator>Reader</creator></metadata>"
            '<manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/>'
            '<item id="toc" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
            '</manifest><spine><itemref idref="one"/></spine></package>',
        )
        archive.writestr(
            "OEBPS/nav.xhtml",
            '<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc">'
            '<a href="one.xhtml#opening">Opening</a></nav></body></html>',
        )
        archive.writestr(
            "OEBPS/one.xhtml",
            "<html><body><h1>Chapter</h1><p>Visible text</p><script>not rendered</script>"
            '<img src="https://invalid.example/external.png"/></body></html>',
        )
        if with_audio:
            archive.writestr("OEBPS/masked.bin", b"OggS audio")
    return buffer.getvalue()


def test_epub_safety_pair_split_and_portable_share(settings, authenticated_client, tmp_path):
    import shutil

    source = tmp_path / "audio-only"
    source.mkdir()
    fixture = Path(__file__).resolve().parents[2] / "tests/fixtures/audio/playback.mp3"
    shutil.copyfile(fixture, source / "script.mp3")
    with authenticated_client(settings) as owner:
        library = create_library(owner, "Original", source_roots=[str(source)], auto_pair=False)
        lib = library["id"]
        assert (
            owner.post(f"/api/v1/book-libraries/{lib}/scan", headers=HEADERS).json()["added_books"]
            == 1
        )

        def upload(payload):
            return owner.post(
                "/api/v1/books/upload",
                headers=HEADERS,
                data={"library_id": lib},
                files={"file": ("sample.epub", payload, "application/epub+zip")},
            )

        rejected = upload(sample_epub(with_audio=True))
        assert rejected.status_code == 422 and rejected.json()["detail"] == "audio_upload_forbidden"
        accepted = upload(sample_epub())
        assert accepted.status_code == 201, accepted.text
        identity = accepted.json()["id"]
        prefix = f"/api/v1/books/{identity}"
        chapter = owner.get(prefix + "/ebook/chapters/0").json()
        assert chapter["title"] == "Opening"
        assert [block["text"] for block in chapter["blocks"]] == ["Chapter", "Visible text"]
        audio = next(
            book for book in owner.get("/api/v1/books").json()["items"] if book["has_audiobook"]
        )
        paired = owner.post(prefix + "/pair", headers=HEADERS, json={"other_book_id": audio["id"]})
        assert paired.status_code == 200, paired.text
        source_audio = source / "script.mp3"
        before = source_audio.stat()
        corrected = owner.patch(
            prefix + "/audiobook/chapters/0", headers=HEADERS, json={"title": "Corrected opening"}
        )
        assert corrected.json() == {"chapter_index": 0, "title": "Corrected opening"}
        sidecar = Path(library["managed_root"]) / identity / ".wildstring" / "manifest.json"
        assert (
            json.loads(sidecar.read_text())["audiobook"]["chapters"][0]["title"]
            == "Corrected opening"
        )
        assert source_audio.stat().st_mtime_ns == before.st_mtime_ns
        assert (
            owner.get(
                prefix + "/audiobook/files/0/stream", headers={"Range": "bytes=0-9"}
            ).status_code
            == 206
        )
        converted = owner.head(
            prefix + "/audiobook/files/0/stream", params={"format": "aac", "bitrate_kbps": 128}
        )
        assert converted.status_code == 200
        assert converted.headers["X-Wildstring-Codec"] == "aac"
        split = owner.post(prefix + "/split", headers=HEADERS, json={"carrier": "audiobook"})
        assert split.status_code == 201, split.text
        assert owner.get(f"/api/v1/books/{split.json()['id']}/audiobook").status_code == 200
        assert owner.get(prefix + "/audiobook").status_code == 404
        assert (
            owner.patch(
                prefix + "/metadata",
                headers=HEADERS,
                json={"title": "Edited EPUB", "locked_fields": ["title"]},
            ).status_code
            == 200
        )

        shared = tmp_path / "shared-edition"
        shutil.copytree(Path(library["managed_root"]) / identity, shared)
        second = create_library(owner, "Recipient", source_roots=[str(shared)])
        scan = owner.post(f"/api/v1/book-libraries/{second['id']}/scan", headers=HEADERS)
        assert scan.json()["added_books"] == 1, scan.text
        restored = owner.get("/api/v1/books", params={"library_id": second["id"]}).json()["items"][
            0
        ]
        assert restored["title"] == "Edited EPUB"
        meta = owner.get(f"/api/v1/books/{restored['id']}/metadata").json()
        assert meta["locked_fields"] == ["title"]


def test_book_metadata_providers_return_only_typed_public_fields(
    settings, authenticated_client, monkeypatch
):
    from urllib.error import HTTPError
    from urllib.parse import urlsplit

    from wildstring.books import providers
    from wildstring.podcasts import PodcastURLRejected

    answers = {
        "openlibrary.org": {
            "docs": [{"title": "Open", "author_name": ["One"], "password": "excluded"}]
        },
        "www.googleapis.com": {
            "items": [
                {
                    "id": "google",
                    "volumeInfo": {"title": "Google", "description": "<script>x</script>"},
                }
            ]
        },
        "itunes.apple.com": {
            "results": [
                {"collectionId": 17, "collectionName": "Apple", "artistName": "Three"},
                {"trackId": 29, "trackName": "Apple Ebook", "artistName": "Author"},
            ]
        },
    }
    observed_queries = []

    def fake_request_bytes(request, **kwargs):
        parts = urlsplit(request.full_url)
        observed_queries.append((parts.hostname, parts.query))
        assert parts.scheme == "https"
        if "FakeIpQuery" in parts.query:
            raise PodcastURLRejected("remote_url_fake_ip")
        if "RateLimitQuery" in parts.query:
            raise HTTPError(request.full_url, 429, "Too Many Requests", {"Retry-After": "12"}, None)
        if parts.hostname == "www.googleapis.com" and "EmptyResultQuery" in parts.query:
            payload = json.dumps({"totalItems": 0}).encode("utf-8")
        else:
            payload = json.dumps(answers[parts.hostname]).encode("utf-8")
        return 200, {}, payload

    monkeypatch.setattr(providers, "request_bytes", fake_request_bytes)
    with authenticated_client(settings) as owner:
        library = create_library(owner, "Search")
        response = owner.post(
            "/api/v1/books/upload",
            headers=HEADERS,
            data={"library_id": library["id"]},
            files={"file": ("search.txt", b"Search", "text/plain")},
        )
        assert response.status_code == 201, response.text
        identity = response.json()["id"]

        # Google Books is disabled by default; Apple iTunes and Open Library are enabled.
        sources = owner.get("/api/v1/books/metadata/sources").json()
        assert [item["id"] for item in sources["items"]] == ["itunes", "openlibrary"]
        assert {item["id"]: item["enabled"] for item in sources["all_sources"]} == {
            "itunes": True,
            "openlibrary": True,
            "google_books": False,
        }
        assert (
            owner.get(
                f"/api/v1/books/{identity}/metadata/search",
                params={"sources": "google_books"},
            ).status_code
            == 422
        )

        # Multi-source search merges iTunes (including ebook trackName) and Open Library.
        multi = owner.get(
            f"/api/v1/books/{identity}/metadata/search",
            params={"sources": "itunes,openlibrary", "q": "Walden"},
        )
        assert multi.status_code == 200, multi.text
        titles = [item["fields"]["title"] for item in multi.json()["items"]]
        assert "Apple" in titles and "Apple Ebook" in titles and "Open" in titles

        # Short (<3 char) Open Library query uses `title=` instead of `q=`.
        short_ol = owner.get(
            f"/api/v1/books/{identity}/metadata/search",
            params={"sources": "openlibrary", "q": "三体"},
        )
        assert short_ol.status_code == 200
        assert any(
            host == "openlibrary.org" and "title=" in query and "&q=" not in f"&{query}"
            for host, query in observed_queries
        )

        # Enabling Google Books allows selecting it via `sources=`.
        updated = owner.put(
            "/api/v1/books/metadata/sources",
            headers=HEADERS,
            json={"google_books": True},
        )
        assert updated.status_code == 200
        assert [item["id"] for item in updated.json()["items"]] == [
            "itunes",
            "openlibrary",
            "google_books",
        ]

        # Explicit provider parameter stays backward-compatible, including Fake-IP 422 & 429.
        for provider, title in (
            ("openlibrary", "Open"),
            ("google_books", "Google"),
            ("itunes", "Apple"),
        ):
            found = owner.get(
                f"/api/v1/books/{identity}/metadata/search", params={"provider": provider}
            )
            assert found.status_code == 200, found.text
            assert found.json()["items"][0]["fields"]["title"] == title
            assert "password" not in found.text and "<script>" not in found.text
        empty_google = owner.get(
            f"/api/v1/books/{identity}/metadata/search",
            params={"provider": "google_books", "q": "EmptyResultQuery"},
        )
        assert empty_google.status_code == 200 and empty_google.json()["items"] == []
        fake_ip = owner.get(
            f"/api/v1/books/{identity}/metadata/search",
            params={"provider": "openlibrary", "q": "FakeIpQuery"},
        )
        assert fake_ip.status_code == 422 and fake_ip.json()["detail"] == "remote_url_fake_ip"
        limited = owner.get(
            f"/api/v1/books/{identity}/metadata/search",
            params={"provider": "google_books", "q": "RateLimitQuery"},
        )
        assert (
            limited.status_code == 429 and limited.json()["detail"] == "book_metadata_rate_limited"
        )


def test_ebook_upload_without_library_id_uses_or_creates_copy_library_never_hardlink(
    settings, authenticated_client, tmp_path
):
    source = tmp_path / "hardlink-source"
    source.mkdir()
    with authenticated_client(settings) as owner:
        hardlink_lib = create_library(
            owner,
            "Studio",
            source_roots=[str(source)],
            storage_mode="hardlink",
        )
        first = owner.post(
            "/api/v1/books/upload",
            headers=HEADERS,
            files={"file": ("DirectOne.txt", "第一章\n直接上传".encode(), "text/plain")},
        )
        assert first.status_code == 201, first.text
        first_book = owner.get(f"/api/v1/books/{first.json()['id']}").json()
        assert first_book["library_id"] != hardlink_lib["id"]
        libs = owner.get("/api/v1/book-libraries").json()["items"]
        copy_libs = [item for item in libs if item["storage_mode"] == "copy"]
        assert len(copy_libs) == 1
        assert copy_libs[0]["default_access"] == "restricted"
        assert first_book["library_id"] == copy_libs[0]["id"]

        music = owner.get("/api/v1/libraries").json()[0]["id"]
        ungranted_reader, _ = listener(owner, [music])
        assert ungranted_reader.get(f"/api/v1/books/{first_book['id']}").status_code == 404

        second = owner.post(
            "/api/v1/books/upload",
            headers=HEADERS,
            files={"file": ("DirectTwo.txt", "第一章\n再次直传".encode(), "text/plain")},
        )
        assert second.status_code == 201, second.text
        second_book = owner.get(f"/api/v1/books/{second.json()['id']}").json()
        assert second_book["library_id"] == copy_libs[0]["id"]


def test_ebook_utf16_inline_runs_child_tail_and_zip_spine_decompression_guards(
    settings, authenticated_client, monkeypatch
):
    from io import BytesIO
    from zipfile import ZipFile

    from PIL import Image

    with authenticated_client(settings) as owner:
        library = create_library(owner, "Guards")
        lib = library["id"]

        # 1. UTF-16 LE BOM TXT upload must not trigger MPEG sync-byte false positive.
        utf16_text = "Chapter 1\n\n\ufffd Safe UTF-16 body."
        up = owner.post(
            "/api/v1/books/upload",
            headers=HEADERS,
            data={"library_id": lib},
            files={"file": ("utf16.txt", utf16_text.encode("utf-16"), "text/plain")},
        )
        assert up.status_code == 201, up.text
        ch0 = owner.get(f"/api/v1/books/{up.json()['id']}/ebook/chapters/0").json()
        assert any("Safe UTF-16 body." in block["text"] for block in ch0["blocks"])

        # 2. XHTML preserves child.tail around stripped tags, inline runs, and nested div>span.
        buf = BytesIO()
        with ZipFile(buf, "w") as archive:
            archive.writestr("mimetype", "application/epub+zip")
            archive.writestr(
                "META-INF/container.xml",
                '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
            )
            archive.writestr(
                "book.opf",
                "<package><metadata><title>Runs Book</title></metadata>"
                '<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>'
                '<spine><itemref idref="c1"/></spine></package>',
            )
            archive.writestr(
                "c1.xhtml",
                "<html><body>"
                "<p>Lead <script>bad()</script>tail <b>bold</b> <em>ital</em> <code>mono</code></p>"
                "<div><span>Inner</span> span</div>"
                "</body></html>",
            )
        runs_up = owner.post(
            "/api/v1/books/upload",
            headers=HEADERS,
            data={"library_id": lib},
            files={"file": ("runs.epub", buf.getvalue(), "application/epub+zip")},
        )
        assert runs_up.status_code == 201, runs_up.text
        blocks = owner.get(f"/api/v1/books/{runs_up.json()['id']}/ebook/chapters/0").json()[
            "blocks"
        ]
        assert "Lead tail" in blocks[0]["text"]
        assert any(r.get("bold") and "bold" in r["text"] for r in blocks[0]["runs"])
        assert any(r.get("italic") and "ital" in r["text"] for r in blocks[0]["runs"])
        assert any(r.get("code") and "mono" in r["text"] for r in blocks[0]["runs"])
        assert blocks[1]["text"] == "Inner span"

        # 3. Excessive spine refs rejected cleanly with 422.
        spine_buf = BytesIO()
        with ZipFile(spine_buf, "w") as archive:
            archive.writestr("mimetype", "application/epub+zip")
            archive.writestr(
                "META-INF/container.xml",
                '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
            )
            refs = "".join('<itemref idref="c1"/>' for _ in range(1005))
            archive.writestr(
                "book.opf",
                "<package><metadata><title>Spine DoS</title></metadata>"
                '<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>'
                f"<spine>{refs}</spine></package>",
            )
            archive.writestr("c1.xhtml", "<html><body><p>Hi</p></body></html>")
        dos_resp = owner.post(
            "/api/v1/books/upload",
            headers=HEADERS,
            data={"library_id": lib},
            files={"file": ("spine-dos.epub", spine_buf.getvalue(), "application/epub+zip")},
        )
        assert dos_resp.status_code == 422

        # 4. DecompressionBombError on oversized cover pixel bomb returns 422 invalid_image.
        tiny_img = BytesIO()
        Image.new("RGB", (20, 20), (120, 90, 60)).save(tiny_img, format="PNG")
        monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 10)
        bomb_cover = owner.post(
            f"/api/v1/books/{runs_up.json()['id']}/cover",
            headers=HEADERS,
            files={"file": ("bomb.png", tiny_img.getvalue(), "image/png")},
        )
        assert bomb_cover.status_code == 422


def test_audiobook_incremental_rescan_auto_pair_isolation_and_manual_pair_merge(
    settings, authenticated_client, tmp_path
):
    import shutil

    from wildstring.library.importer import import_music

    fixture = Path(__file__).resolve().parents[2] / "tests/fixtures/audio/playback.mp3"
    source = tmp_path / "audio-books"
    series = source / "Series One"
    series.mkdir(parents=True)
    shutil.copyfile(fixture, series / "part1.mp3")

    with authenticated_client(settings) as owner:
        lib = create_library(owner, "AudioRescan", source_roots=[str(source)], auto_pair=True)
        lib_id = lib["id"]

        # Upload an independent ebook that must NOT be overwritten when scanning same folder.
        ext = owner.post(
            "/api/v1/books/upload",
            headers=HEADERS,
            data={"library_id": lib_id},
            files={"file": ("external.txt", b"Series One\nIndependent upload.", "text/plain")},
        )
        assert ext.status_code == 201
        ext_id = ext.json()["id"]

        scan1 = owner.post(f"/api/v1/book-libraries/{lib_id}/scan", headers=HEADERS)
        assert scan1.status_code == 200 and scan1.json()["added_books"] == 1
        scanned_audio = next(
            b
            for b in owner.get("/api/v1/books", params={"library_id": lib_id}).json()["items"]
            if b["id"] != ext_id
        )
        audio_id = scanned_audio["id"]

        # Save chapter title edit and listening checkpoint before incremental rescan.
        assert (
            owner.patch(
                f"/api/v1/books/{audio_id}/audiobook/chapters/0",
                headers=HEADERS,
                json={"title": "Edited Part 1"},
            ).status_code
            == 200
        )
        assert (
            owner.put(
                f"/api/v1/books/{audio_id}/listening-progress",
                headers=HEADERS,
                json={
                    "session_id": "audio-session-0001",
                    "device_id": "d1",
                    "base_version": 0,
                    "sequence": 1,
                    "chapter_index": 0,
                    "chapter_position_ms": 500,
                },
            ).status_code
            == 200
        )

        # Add part2.mp3 in same directory and rescan -> same book_id, preserved title & progress!
        shutil.copyfile(fixture, series / "part2.mp3")
        scan2 = owner.post(f"/api/v1/book-libraries/{lib_id}/scan", headers=HEADERS)
        assert scan2.status_code == 200 and scan2.json()["updated_books"] == 1
        chapters = owner.get(f"/api/v1/books/{audio_id}/audiobook").json()["chapters"]
        assert len(chapters) == 2 and chapters[0]["title"] == "Edited Part 1"
        assert owner.get(f"/api/v1/books/{audio_id}/listening-progress").json()["version"] == 1
        assert owner.get(f"/api/v1/books/{ext_id}/audiobook").status_code == 404

        # Manual pair merges newer reading progress & removes paired directory cleanly.
        assert (
            owner.put(
                f"/api/v1/books/{ext_id}/reading-progress",
                headers=HEADERS,
                json={
                    "session_id": "ebook-session-0001",
                    "device_id": "d1",
                    "base_version": 0,
                    "sequence": 1,
                    "spine_index": 0,
                    "block_index": 0,
                    "char_offset": 2,
                },
            ).status_code
            == 200
        )
        paired = owner.post(
            f"/api/v1/books/{audio_id}/pair",
            headers=HEADERS,
            json={"other_book_id": ext_id},
        )
        assert paired.status_code == 200
        assert not (Path(lib["managed_root"]) / ext_id).exists()
        assert owner.get(f"/api/v1/books/{audio_id}/reading-progress").json()["char_offset"] == 2
        assert callable(import_music)


def test_zero_block_progress_restart_intent_and_access_list(settings, authenticated_client):
    from io import BytesIO
    from zipfile import ZipFile

    buf = BytesIO()
    with ZipFile(buf, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
        )
        archive.writestr(
            "book.opf",
            "<package><metadata><title>Blank</title></metadata>"
            '<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>'
            '<spine><itemref idref="c1"/></spine></package>',
        )
        archive.writestr("c1.xhtml", "<html><body><div></div></body></html>")

    with authenticated_client(settings) as owner:
        lib = create_library(owner, "BlankCap")
        music = owner.get("/api/v1/libraries").json()[0]["id"]
        reader, user_id = listener(owner, [music])
        assert (
            owner.put(
                f"/api/v1/book-libraries/{lib['id']}/access/{user_id}",
                headers=HEADERS,
                json={"granted": True},
            ).status_code
            == 200
        )
        access = owner.get(f"/api/v1/book-libraries/{lib['id']}/access")
        assert access.status_code == 200 and access.json()["user_ids"] == [user_id]
        assert reader.get(f"/api/v1/book-libraries/{lib['id']}/access").status_code == 403

        up = owner.post(
            "/api/v1/books/upload",
            headers=HEADERS,
            data={"library_id": lib["id"]},
            files={"file": ("blank.epub", buf.getvalue(), "application/epub+zip")},
        )
        assert up.status_code == 201
        bid = up.json()["id"]
        fin = owner.put(
            f"/api/v1/books/{bid}/reading-progress",
            headers=HEADERS,
            json={
                "session_id": "reading-done-00001",
                "device_id": "d1",
                "base_version": 0,
                "sequence": 1,
                "spine_index": 0,
                "block_index": 0,
                "char_offset": 0,
                "completed": True,
            },
        )
        assert fin.status_code == 200 and fin.json()["completed"] is True
        restarted = owner.put(
            f"/api/v1/books/{bid}/reading-progress",
            headers=HEADERS,
            json={
                "session_id": "reading-restart-01",
                "device_id": "d1",
                "base_version": 1,
                "sequence": 1,
                "spine_index": 0,
                "block_index": 0,
                "char_offset": 0,
                "intent": "restart",
            },
        )
        assert restarted.status_code == 200 and restarted.json()["completed"] is False


def test_book_library_update_owner_path_privacy_and_watch_discovery(
    settings, authenticated_client, tmp_path
):
    watched_dir = tmp_path / "watched-books"
    paused_dir = tmp_path / "paused-books"
    watched_dir.mkdir()
    paused_dir.mkdir()
    with authenticated_client(settings) as owner:
        created = create_library(
            owner,
            "Governance",
            source_roots=[str(watched_dir)],
            default_access="restricted",
        )
        assert [src["root"] for src in created["sources"]] == [str(watched_dir)]
        assert created["sources"][0]["watch_enabled"] == 1

        # Owner update can attach a paused source directory, rename, and flip default_access.
        updated = owner.put(
            f"/api/v1/book-libraries/{created['id']}",
            headers=HEADERS,
            json={
                "name": "Governance v2",
                "source_roots": [str(watched_dir), str(paused_dir)],
                "paused_source_roots": [str(paused_dir)],
                "default_access": "all",
                "auto_pair": False,
                "version": created["version"],
            },
        )
        assert updated.status_code == 200, updated.text
        updated_body = updated.json()
        assert updated_body["name"] == "Governance v2"
        assert updated_body["default_access"] == "all"
        assert updated_body["auto_pair"] is False
        assert updated_body["version"] == 2
        assert {src["root"]: src["watch_enabled"] for src in updated_body["sources"]} == {
            str(watched_dir): 1,
            str(paused_dir): 0,
        }

        # Version conflict and direct storage_mode swap require migration.
        stale = owner.put(
            f"/api/v1/book-libraries/{created['id']}",
            headers=HEADERS,
            json={"name": "Stale", "version": 1},
        )
        assert stale.status_code == 409 and stale.json()["detail"] == "library_version_conflict"
        swap = owner.put(
            f"/api/v1/book-libraries/{created['id']}",
            headers=HEADERS,
            json={"name": "Governance v2", "storage_mode": "hardlink", "version": 2},
        )
        assert swap.status_code == 409 and swap.json()["detail"] == "library_migration_required"

        # Non-owner gets metadata only, never managed_root or physical source paths.
        music = owner.get("/api/v1/libraries").json()[0]["id"]
        reader, _ = listener(owner, [music])
        owner_listing = next(
            item
            for item in owner.get("/api/v1/book-libraries").json()["items"]
            if item["id"] == created["id"]
        )
        assert owner_listing["managed_root"] == created["managed_root"]
        assert len(owner_listing["sources"]) == 2
        reader_listing = next(
            item
            for item in reader.get("/api/v1/book-libraries").json()["items"]
            if item["id"] == created["id"]
        )
        assert reader_listing["default_access"] == "all"
        assert "managed_root" not in reader_listing
        assert "sources" not in reader_listing

        # Daemon discover_sources() skips empty unchanged folders, imports watched files, ignores paused ones.
        manager = owner.app.state.management
        manager.stop()
        manager.discover_sources()
        assert owner.get(f"/api/v1/book-libraries/{created['id']}/scans").json()["items"] == []

        (watched_dir / "WatchedBook.txt").write_text("第一章\n自动监听入库")
        (paused_dir / "PausedBook.txt").write_text("第一章\n暂停监听目录")
        manager.discover_sources()

        books = owner.get("/api/v1/books", params={"library_id": created["id"]}).json()["items"]
        assert [b["title"] for b in books] == ["WatchedBook"]
        scans_after_first = owner.get(f"/api/v1/book-libraries/{created['id']}/scans").json()[
            "items"
        ]
        assert len(scans_after_first) == 1

        # Calling discover_sources() again with no disk changes must not enqueue duplicate scan jobs.
        manager.discover_sources()
        scans_after_idle = owner.get(f"/api/v1/book-libraries/{created['id']}/scans").json()[
            "items"
        ]
        assert len(scans_after_idle) == 1


def test_unlibrary_upload_restricted_for_non_owner_and_authorized_reuse(
    settings, authenticated_client, tmp_path
):
    source = tmp_path / "hardlink-only"
    source.mkdir()
    with authenticated_client(settings) as owner:
        create_library(owner, "Studio", source_roots=[str(source)], storage_mode="hardlink")
        music = owner.get("/api/v1/libraries").json()[0]["id"]
        librarian, lib_user_id = listener(owner, [music], profile="librarian")
        denied = librarian.post(
            "/api/v1/books/upload",
            headers=HEADERS,
            files={"file": ("NoCopyLib.txt", "第一章\n未授权建库".encode(), "text/plain")},
        )
        assert denied.status_code == 403
        assert denied.json()["detail"] == "book_upload_library_required"
        assert len(owner.get("/api/v1/book-libraries").json()["items"]) == 1

        team_copy = create_library(owner, "Team Copy", default_access="restricted")
        assert (
            owner.put(
                f"/api/v1/book-libraries/{team_copy['id']}/access/{lib_user_id}",
                headers=HEADERS,
                json={"granted": True},
            ).status_code
            == 200
        )
        ungranted_resp = owner.post(
            "/api/v1/manage/users",
            headers=HEADERS,
            json={
                "username": "ungranted-reader",
                "password": "ungranted-test-password",
                "profile": "listener",
                "library_ids": [music],
            },
        )
        assert ungranted_resp.status_code == 201
        reader = TestClient(owner.app)
        assert (
            reader.post(
                "/api/v1/auth/login",
                headers=HEADERS,
                json={"username": "ungranted-reader", "password": "ungranted-test-password"},
            ).status_code
            == 200
        )

        uploaded = librarian.post(
            "/api/v1/books/upload",
            headers=HEADERS,
            files={"file": ("SharedTeamBook.txt", "第一章\n副本书库直传".encode(), "text/plain")},
        )
        assert uploaded.status_code == 201, uploaded.text
        book_id = uploaded.json()["id"]
        assert librarian.get(f"/api/v1/books/{book_id}").json()["library_id"] == team_copy["id"]
        assert reader.get(f"/api/v1/books/{book_id}").status_code == 404


def test_cover_save_failure_preserves_committed_ebook_and_audiobook(
    settings, authenticated_client, monkeypatch, tmp_path
):
    import shutil
    from io import BytesIO
    from zipfile import ZipFile

    from mutagen.id3 import APIC, ID3
    from mutagen.mp3 import MP3
    from PIL import Image

    from wildstring.books.service import Books

    img_buf = BytesIO()
    Image.new("RGB", (16, 16), (90, 120, 80)).save(img_buf, format="PNG")
    epub_buf = BytesIO()
    with ZipFile(epub_buf, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
        )
        archive.writestr(
            "book.opf",
            "<package><metadata><title>Cover Fail EPUB</title></metadata>"
            '<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>'
            '<item id="cov" href="cover.png" media-type="image/png" properties="cover-image"/></manifest>'
            '<spine><itemref idref="c1"/></spine></package>',
        )
        archive.writestr("c1.xhtml", "<html><body><p>Body keeps living.</p></body></html>")
        archive.writestr("cover.png", img_buf.getvalue())

    fixture = Path(__file__).resolve().parents[2] / "tests/fixtures/audio/playback.mp3"
    audio_dir = tmp_path / "audio-cover-fail"
    audio_dir.mkdir()
    shutil.copyfile(fixture, audio_dir / "track.mp3")
    mp3 = MP3(audio_dir / "track.mp3", ID3=ID3)
    if mp3.tags is None:
        mp3.add_tags()
    mp3.tags.add(APIC(encoding=3, mime="image/png", type=3, desc="Cover", data=img_buf.getvalue()))
    mp3.save()

    with authenticated_client(settings) as owner:
        lib = create_library(owner, "CoverFail")
        cover_attempts = 0

        def broken_cover(self, managed_root, book_id, jpeg):
            nonlocal cover_attempts
            cover_attempts += 1
            raise OSError("disk full")

        monkeypatch.setattr(Books, "_save_cover", broken_cover)

        up = owner.post(
            "/api/v1/books/upload",
            headers=HEADERS,
            data={"library_id": lib["id"]},
            files={"file": ("coverfail.epub", epub_buf.getvalue(), "application/epub+zip")},
        )
        assert up.status_code == 201, up.text
        ebook_id = up.json()["id"]
        assert cover_attempts >= 1
        assert owner.get(f"/api/v1/books/{ebook_id}").json()["has_cover"] is False
        assert owner.get(f"/api/v1/books/{ebook_id}/ebook/download").status_code == 200
        with Database(settings.data_dir).connect() as db:
            ebook_row = db.execute(
                "SELECT managed_path FROM book_ebooks WHERE book_id=?", (ebook_id,)
            ).fetchone()
            assert (Path(lib["managed_root"]) / ebook_row["managed_path"]).is_file()

        with Database(settings.data_dir).connect() as db:
            lib_row = db.execute("SELECT * FROM book_libraries WHERE id=?", (lib["id"],)).fetchone()
        audio_id = Books(Database(settings.data_dir), settings).audiobook(
            lib_row, audio_dir, [Path("track.mp3")], "Cover Fail Audio", extract_cover=True
        )
        assert cover_attempts >= 2
        assert owner.get(f"/api/v1/books/{audio_id}").json()["has_cover"] is False
        assert owner.get(f"/api/v1/books/{audio_id}/audiobook/files/0/stream").status_code == 200
        with Database(settings.data_dir).connect() as db:
            audio_row = db.execute(
                "SELECT managed_path FROM book_audiobook_files WHERE book_id=?", (audio_id,)
            ).fetchone()
            assert (Path(lib["managed_root"]) / audio_row["managed_path"]).is_file()


def test_audiobook_prepend_track_remaps_progress_bookmarks_and_manual_scan_lock(
    settings, authenticated_client, tmp_path
):
    import shutil
    import time
    from threading import Event, Thread

    import pytest
    from fastapi import HTTPException
    from filelock import FileLock
    from mutagen.id3 import ID3, TIT2
    from mutagen.mp3 import MP3

    from wildstring.books.service import Books

    fixture = Path(__file__).resolve().parents[2] / "tests/fixtures/audio/playback.mp3"
    source = tmp_path / "prepend-audio"
    series = source / "Serial Story"
    series.mkdir(parents=True)

    def write_tagged_mp3(target: Path, title: str) -> None:
        shutil.copyfile(fixture, target)
        audio = MP3(target, ID3=ID3)
        if audio.tags is None:
            audio.add_tags()
        audio.tags.delall("TIT2")
        audio.tags.add(TIT2(encoding=3, text=title))
        audio.save()

    write_tagged_mp3(series / "02.mp3", "Part Two")

    with authenticated_client(settings) as owner:
        lib = create_library(owner, "PrependAudio", source_roots=[str(source)])
        assert (
            owner.post(f"/api/v1/book-libraries/{lib['id']}/scan", headers=HEADERS).status_code
            == 200
        )
        book_id = owner.get("/api/v1/books", params={"library_id": lib["id"]}).json()["items"][0][
            "id"
        ]

        assert (
            owner.patch(
                f"/api/v1/books/{book_id}/audiobook/chapters/0",
                headers=HEADERS,
                json={"title": "Chapter Two Edited"},
            ).status_code
            == 200
        )
        assert (
            owner.put(
                f"/api/v1/books/{book_id}/listening-progress",
                headers=HEADERS,
                json={
                    "session_id": "prepend-audio-session",
                    "device_id": "d1",
                    "base_version": 0,
                    "sequence": 1,
                    "chapter_index": 0,
                    "chapter_position_ms": 400,
                    "playback_rate": 1.25,
                },
            ).status_code
            == 200
        )
        mark = owner.post(
            f"/api/v1/books/{book_id}/bookmarks",
            headers=HEADERS,
            json={"kind": "audio", "chapter_index": 0, "position_ms": 300, "excerpt": "Two"},
        )
        assert mark.status_code == 201

        write_tagged_mp3(series / "01.mp3", "Part One")
        rescan = owner.post(f"/api/v1/book-libraries/{lib['id']}/scan", headers=HEADERS)
        assert rescan.status_code == 200 and rescan.json()["updated_books"] == 1

        chapters = owner.get(f"/api/v1/books/{book_id}/audiobook").json()["chapters"]
        assert [c["title"] for c in chapters] == ["Part One", "Chapter Two Edited"]

        progress = owner.get(f"/api/v1/books/{book_id}/listening-progress").json()
        assert progress["version"] == 1
        assert progress["chapter_index"] == 1
        assert progress["chapter_position_ms"] == 400
        assert progress["book_position_ms"] == chapters[1]["start_book_ms"] + 400

        marks = owner.get(f"/api/v1/books/{book_id}/bookmarks").json()["items"]
        assert len(marks) == 1
        assert marks[0]["chapter_index"] == 1
        assert marks[0]["position_ms"] == 300

        # Background watched_only scan fails fast with 409; manual scan waits briefly for lock.
        with Database(settings.data_dir).connect() as db:
            lib_row = db.execute("SELECT * FROM book_libraries WHERE id=?", (lib["id"],)).fetchone()
        books_svc = Books(Database(settings.data_dir), settings)
        with FileLock(settings.data_dir / "library-scan.lock", timeout=0):
            with pytest.raises(HTTPException) as exc:
                books_svc.scan(lib_row, watched_only=True)
            assert exc.value.status_code == 409 and exc.value.detail == "scan_busy"

        acquired = Event()

        def hold_lock() -> None:
            with FileLock(settings.data_dir / "library-scan.lock", timeout=0):
                acquired.set()
                time.sleep(0.25)

        worker = Thread(target=hold_lock)
        worker.start()
        assert acquired.wait(timeout=2)
        manual_scan = owner.post(f"/api/v1/book-libraries/{lib['id']}/scan", headers=HEADERS)
        worker.join(timeout=2)
        assert manual_scan.status_code == 200


def test_books_catalog_server_search_filters_and_pagination(
    settings, authenticated_client, tmp_path
):
    import shutil

    fixture = Path(__file__).resolve().parents[2] / "tests/fixtures/audio/playback.mp3"
    audio_dir = tmp_path / "catalog-audio"
    audio_dir.mkdir()
    shutil.copyfile(fixture, audio_dir / "Voice_Episode.mp3")

    with authenticated_client(settings) as owner:
        lib = create_library(owner, "ServerSearch", source_roots=[str(audio_dir)])
        assert (
            owner.post(f"/api/v1/book-libraries/{lib['id']}/scan", headers=HEADERS).status_code
            == 200
        )
        alpha = owner.post(
            "/api/v1/books/upload",
            headers=HEADERS,
            data={"library_id": lib["id"]},
            files={"file": ("alpha.txt", "第一章\n正文".encode(), "text/plain")},
        ).json()["id"]
        beta = owner.post(
            "/api/v1/books/upload",
            headers=HEADERS,
            data={"library_id": lib["id"]},
            files={"file": ("beta.txt", "第一章\n正文".encode(), "text/plain")},
        ).json()["id"]
        bracket = owner.post(
            "/api/v1/books/upload",
            headers=HEADERS,
            data={"library_id": lib["id"]},
            files={"file": ("bracket.txt", "第一章\n正文".encode(), "text/plain")},
        ).json()["id"]

        assert (
            owner.patch(
                f"/api/v1/books/{alpha}/metadata",
                headers=HEADERS,
                json={
                    "title": "Alpha 50% Story",
                    "subtitle": "Sub_Title",
                    "authors": ["Alice Smith"],
                },
            ).status_code
            == 200
        )
        assert (
            owner.patch(
                f"/api/v1/books/{beta}/metadata",
                headers=HEADERS,
                json={"title": "Beta_Guide", "authors": ["陈默"]},
            ).status_code
            == 200
        )
        assert (
            owner.patch(
                f"/api/v1/books/{bracket}/metadata",
                headers=HEADERS,
                json={"title": "[Bracket] Notes", "authors": []},
            ).status_code
            == 200
        )

        assert (
            owner.put(
                f"/api/v1/books/{alpha}/reading-progress",
                headers=HEADERS,
                json={
                    "session_id": "search-alpha-session",
                    "device_id": "d1",
                    "base_version": 0,
                    "sequence": 1,
                    "spine_index": 0,
                    "block_index": 0,
                    "char_offset": 1,
                },
            ).status_code
            == 200
        )
        assert (
            owner.put(
                f"/api/v1/books/{beta}/reading-progress",
                headers=HEADERS,
                json={
                    "session_id": "search-beta-session1",
                    "device_id": "d1",
                    "base_version": 0,
                    "sequence": 1,
                    "spine_index": 0,
                    "block_index": 1,
                    "char_offset": 0,
                    "completed": True,
                },
            ).status_code
            == 200
        )

        assert [
            b["id"]
            for b in owner.get(
                "/api/v1/books", params={"library_id": lib["id"], "q": "50%"}
            ).json()["items"]
        ] == [alpha]
        assert [
            b["id"]
            for b in owner.get(
                "/api/v1/books", params={"library_id": lib["id"], "q": "sub_title"}
            ).json()["items"]
        ] == [alpha]
        assert [
            b["id"]
            for b in owner.get(
                "/api/v1/books", params={"library_id": lib["id"], "q": "陈默"}
            ).json()["items"]
        ] == [beta]
        assert [
            b["id"]
            for b in owner.get("/api/v1/books", params={"library_id": lib["id"], "q": "["}).json()[
                "items"
            ]
        ] == [bracket]
        assert (
            len(
                owner.get(
                    "/api/v1/books", params={"library_id": lib["id"], "format": "ebook"}
                ).json()["items"]
            )
            == 3
        )
        audio_items = owner.get(
            "/api/v1/books", params={"library_id": lib["id"], "format": "audio"}
        ).json()["items"]
        assert len(audio_items) == 1 and audio_items[0]["has_audiobook"] is True
        assert [
            b["id"]
            for b in owner.get(
                "/api/v1/books", params={"library_id": lib["id"], "progress_status": "in_progress"}
            ).json()["items"]
        ] == [alpha]
        assert [
            b["id"]
            for b in owner.get(
                "/api/v1/books", params={"library_id": lib["id"], "progress_status": "finished"}
            ).json()["items"]
        ] == [beta]
        assert (
            len(
                owner.get(
                    "/api/v1/books", params={"library_id": lib["id"], "progress_status": "unread"}
                ).json()["items"]
            )
            == 2
        )

        page1 = owner.get(
            "/api/v1/books", params={"library_id": lib["id"], "limit": 2, "offset": 0}
        ).json()
        page2 = owner.get(
            "/api/v1/books", params={"library_id": lib["id"], "limit": 2, "offset": 2}
        ).json()
        assert len(page1["items"]) == 2 and page1["total"] == 4 and page1["has_more"] is True
        assert len(page2["items"]) == 2 and page2["total"] == 4 and page2["has_more"] is False
        assert {item["id"] for item in page1["items"]}.isdisjoint(
            {item["id"] for item in page2["items"]}
        )
