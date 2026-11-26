"""Loopback-only Google OAuth and Drive HTTP fixture for test processes."""

import hashlib
import json
import re
import time
from collections import Counter
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

FOLDER = "application/vnd.google-apps.folder"


class DriveFixture:
    def __init__(self):
        self.files = {}
        self.content = {}
        self.uploads = {}
        self.changes = []
        self.requests = Counter()
        self.ranges = []
        self.tokens = []
        self.reject = set()
        self.rate_limit = set()
        self.expired_cursor = False
        self.invalid_grant = False
        self.upload_interrupted = False
        self.upload_session_url = None
        self.delay = 0
        self.subject = "test-owner"

    def folder(self, identity, name, parent=None):
        self.files[identity] = {
            "id": identity,
            "name": name,
            "mimeType": FOLDER,
            "parents": [parent] if parent else [],
        }
        return self.files[identity]

    def file(self, identity, name, parent, data, mime="application/octet-stream"):
        old = self.files.get(identity, {})
        self.files[identity] = {
            "id": identity,
            "name": name,
            "parents": [parent],
            "size": str(len(data)),
            "version": str(int(old.get("version", 0)) + 1),
            "mimeType": mime,
            "md5Checksum": hashlib.md5(data, usedforsecurity=False).hexdigest(),
        }
        self.content[identity] = data
        self.changes.append({"fileId": identity, "file": self.files[identity]})
        return self.files[identity]

    def remove(self, identity):
        del self.files[identity]
        self.content.pop(identity, None)
        self.changes.append({"fileId": identity, "removed": True})


@contextmanager
def drive_fixture():
    fixture = DriveFixture()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def send(self, status=200, data=None, headers=None):
            if isinstance(data, dict):
                data = json.dumps(data).encode()
            data = data or b""
            self.send_response(status)
            self.send_header("Content-Length", str(len(data)))
            for key, value in (headers or {}).items():
                self.send_header(key, str(value))
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                # Browsers may close a media request when seeking or changing tracks.
                return

        def do_POST(self):
            path = urlsplit(self.path).path
            fixture.requests["POST", path] += 1
            data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            if path == "/token":
                fields = {key: value[0] for key, value in parse_qs(data.decode()).items()}
                fixture.tokens.append(fields)
                if fields["grant_type"] == "refresh_token" and fixture.invalid_grant:
                    self.send(400, {"error": "invalid_grant"})
                else:
                    self.send(
                        data={
                            "access_token": f"test-access-{len(fixture.tokens)}",
                            "expires_in": 3600,
                            **(
                                {"refresh_token": "test-refresh-token"}
                                if fields["grant_type"] == "authorization_code"
                                else {}
                            ),
                        }
                    )
            elif path == "/revoke":
                self.send()
            elif path == "/drive/v3/files":
                payload = json.loads(data)
                self.send(
                    data=fixture.folder(
                        uuid4().hex,
                        payload["name"],
                        next(iter(payload.get("parents", [])), None),
                    )
                )
            elif path == "/upload/drive/v3/files":
                identity = uuid4().hex
                fixture.uploads[identity] = (json.loads(data), bytearray())
                self.send(
                    headers={
                        "Location": fixture.upload_session_url
                        or f"{fixture.base}/upload/drive/v3/files?upload_id={identity}",
                    }
                )
            else:
                self.send(404)

        def do_PUT(self):
            url = urlsplit(self.path)
            fixture.requests["PUT", url.path] += 1
            identity = parse_qs(url.query)["upload_id"][0]
            metadata, data = fixture.uploads[identity]
            value = self.headers["Content-Range"]
            if value.startswith("bytes */"):
                self.send(308, headers={"Range": f"bytes=0-{len(data) - 1}"} if data else {})
                return
            start, end, total = map(int, re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", value).groups())
            content = self.rfile.read(int(self.headers["Content-Length"]))
            if fixture.upload_interrupted:
                fixture.upload_interrupted = False
                data.extend(content[: 256 * 1024])
                self.send(503)
                return
            if start != len(data) or len(content) != end - start + 1:
                self.send(400)
                return
            data.extend(content)
            if len(data) < total:
                self.send(308, headers={"Range": f"bytes=0-{len(data) - 1}"})
            else:
                self.send(
                    data=fixture.file(
                        identity, metadata["name"], metadata["parents"][0], bytes(data)
                    )
                )

        def do_GET(self):
            url = urlsplit(self.path)
            params = parse_qs(url.query)
            path = url.path
            fixture.requests["GET", path] += 1
            if path == "/drive/v3/about":
                self.send(
                    data={
                        "user": {
                            "emailAddress": "owner@example.test",
                            "permissionId": fixture.subject,
                        }
                    }
                )
            elif path == "/drive/v3/changes/startPageToken":
                self.send(data={"startPageToken": str(len(fixture.changes))})
            elif path == "/drive/v3/changes":
                if fixture.expired_cursor:
                    fixture.expired_cursor = False
                    self.send(410)
                    return
                token = int(params["pageToken"][0])
                changes = fixture.changes[token:]
                result = {"changes": changes[:2]}
                if len(changes) > 2:
                    result["nextPageToken"] = str(token + 2)
                else:
                    result["newStartPageToken"] = str(len(fixture.changes))
                self.send(data=result)
            elif path == "/drive/v3/files":
                parent = params["q"][0].split("'")[1]
                files = [item for item in fixture.files.values() if parent in item["parents"]]
                self.send(data={"files": files})
            elif path.startswith("/drive/v3/files/"):
                identity = path.rsplit("/", 1)[1]
                if identity not in fixture.files:
                    self.send(404)
                elif params.get("alt") != ["media"]:
                    self.send(data=fixture.files[identity])
                elif identity in fixture.reject:
                    self.send(401)
                elif identity in fixture.rate_limit:
                    self.send(429, headers={"Retry-After": "23"})
                else:
                    data = fixture.content[identity]
                    start, end = map(int, self.headers["Range"].removeprefix("bytes=").split("-"))
                    fixture.ranges.append((identity, start, end))
                    if fixture.delay:
                        time.sleep(fixture.delay)
                    self.send(
                        206,
                        data[start : end + 1],
                        {"Content-Range": f"bytes {start}-{end}/{len(data)}"},
                    )
            else:
                self.send(404)

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        fixture.base = f"http://127.0.0.1:{server.server_port}"
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield fixture
        finally:
            server.shutdown()
            thread.join()
