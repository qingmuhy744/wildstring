"""Book libraries share the server's storage boundary and use separate grants."""

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
    from wildstring.books import providers

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
            "results": [{"collectionId": 17, "collectionName": "Apple", "artistName": "Three"}]
        },
    }

    def fetch(url, mode, proxy):
        from urllib.parse import urlsplit

        assert urlsplit(url).scheme == "https"
        return answers[urlsplit(url).hostname]

    monkeypatch.setattr(providers, "fetch_itunes_json", fetch)
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
