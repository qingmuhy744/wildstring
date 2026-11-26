"""Google Drive v3 transport using fixed endpoints and the shared outbound policy."""

import json
import re
from contextlib import ExitStack, contextmanager
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request

import anyio

from wildstring.outbound import OutboundError, open_response, request_bytes
from wildstring.storage.media import MediaStore, RemoteObject

FOLDER = "application/vnd.google-apps.folder"
FIELDS = "id,name,mimeType,parents,trashed,size,md5Checksum,modifiedTime,version"
FILE_ID = re.compile(r"[A-Za-z0-9_-]{1,256}")
CHUNK = 8 * 1024 * 1024


class DriveError(Exception):
    def __init__(self, code, status=None, retry_after=None):
        super().__init__(code)
        self.code, self.status, self.retry_after = code, status, retry_after


def translate(error):
    if isinstance(error, OutboundError):
        return DriveError("remote_storage_unavailable", error.http_status)
    with error:
        retry = error.headers.get("Retry-After", "")
        status = error.code
        reasons = ()
        if status == 403:
            try:
                reasons = [
                    item.get("reason")
                    for item in json.loads(error.read(8192)).get("error", {}).get("errors", [])
                ]
            except (ValueError, TypeError, AttributeError):
                # A non-JSON error is still mapped by its HTTP status.
                reasons = ()
    if status == 429 or {"rateLimitExceeded", "userRateLimitExceeded"}.intersection(reasons):
        return DriveError(
            "remote_storage_rate_limited",
            status,
            min(int(retry), 86400) if retry.isdecimal() and len(retry) <= 10 else 60,
        )
    if status == 401:
        return DriveError("remote_storage_auth_required", status)
    if status == 403:
        return DriveError("remote_storage_forbidden", status)
    if status == 404:
        return DriveError("remote_storage_file_not_found", status)
    return DriveError("remote_storage_unavailable", status)


class GoogleDrive(MediaStore):
    def __init__(self, account, token, network, *, base="https://www.googleapis.com"):
        self.account, self.token, self.network, self.base = account, token, network, base

    def url(self, path, params):
        return f"{self.base}{path}" + (f"?{urlencode(params)}" if params else "")

    def request(self, url, method, data, headers, token):
        return Request(
            url,
            method=method,
            data=data,
            headers={"Authorization": f"Bearer {token}", **headers},
        )

    @contextmanager
    def response(self, url, method="GET", data=None, headers=None, *, resumable=False):
        headers = headers or {}
        token = self.token()
        for attempt in range(2):
            # Keep setup errors separate from read failures after a response has started.
            try:
                with ExitStack() as stack:
                    response = stack.enter_context(
                        open_response(
                            self.request(url, method, data, headers, token),
                            service="gdrive",
                            **self.network(),
                        )
                    )
                    yield response.status, response.headers, response
                    return
            except HTTPError as error:
                if error.code == 401 and attempt == 0:
                    error.close()
                    token = self.token(rejected=token)
                    continue
                if error.code == 308 and resumable:
                    with error:
                        yield 308, error.headers, error
                    return
                raise translate(error) from None
            except OutboundError as error:
                raise translate(error) from None

    def json(self, path, params=None, *, payload=None):
        data = json.dumps(payload).encode() if payload is not None else None
        with self.response(
            self.url(path, params),
            "POST" if data else "GET",
            data,
            {"Content-Type": "application/json"} if data else None,
        ) as (_, _, response):
            return self.decode(response)

    @staticmethod
    def decode(response):
        try:
            data = response.read(4 * 1024 * 1024 + 1)
            if len(data) > 4 * 1024 * 1024:
                raise ValueError
            result = json.loads(data)
            if not isinstance(result, dict):
                raise ValueError
            return result
        except (ValueError, RecursionError):
            raise DriveError("remote_storage_invalid_response") from None

    @staticmethod
    def file_id(value):
        if not FILE_ID.fullmatch(value):
            raise DriveError("remote_storage_folder_invalid")
        return value

    def folder(self, folder_id):
        item = self.json(f"/drive/v3/files/{self.file_id(folder_id)}", {"fields": FIELDS})
        if item.get("mimeType") != FOLDER or item.get("trashed"):
            raise DriveError("remote_storage_folder_invalid")
        return item

    def writable(self):
        if self.account["scope_mode"] != "drive_file":
            raise DriveError("remote_storage_read_only")

    def create_folder(self, name, parent=None):
        self.writable()
        payload = {"name": name, "mimeType": FOLDER}
        if parent:
            payload["parents"] = [self.file_id(parent)]
        return self.json("/drive/v3/files", {"fields": FIELDS}, payload=payload)

    def children(self, folder_id, extra_query=""):
        params = {
            "q": f"'{self.file_id(folder_id)}' in parents and trashed=false" + extra_query,
            "pageSize": 1000,
            "fields": f"nextPageToken,files({FIELDS})",
            "spaces": "drive",
        }
        while True:
            page = self.json("/drive/v3/files", params)
            yield from page.get("files", [])
            if not (token := page.get("nextPageToken")):
                break
            params["pageToken"] = token

    def start_cursor(self):
        return self.json("/drive/v3/changes/startPageToken")["startPageToken"]

    def list_tree(self, root_folder_id):
        tree = {}
        folders = [root_folder_id]
        while folders:
            for item in self.children(folders.pop()):
                if item["id"] not in tree and item["id"] != root_folder_id:
                    tree[item["id"]] = item
                    if item["mimeType"] == FOLDER:
                        folders.append(item["id"])
        return tree

    def list_changes(self, _root_folder_id, page_token):
        changes = {}
        while True:
            page = self.json(
                "/drive/v3/changes",
                {
                    "pageToken": page_token,
                    "pageSize": 1000,
                    "spaces": "drive",
                    "includeRemoved": "true",
                    "fields": f"nextPageToken,newStartPageToken,changes(fileId,removed,file({FIELDS}))",
                },
            )
            for change in page.get("changes", []):
                changes[change["fileId"]] = None if change.get("removed") else change.get("file")
            if not (page_token := page.get("nextPageToken")):
                return changes, page["newStartPageToken"]

    @contextmanager
    def range_response(self, ref, start, end):
        url = self.url(f"/drive/v3/files/{self.file_id(ref.id)}", {"alt": "media"})
        with self.response(url, headers={"Range": f"bytes={start}-{end}"}) as (
            status,
            headers,
            response,
        ):
            full = start == 0 and end == ref.size - 1
            expected = f"bytes {start}-{end}/{ref.size}"
            if status != 206 or headers.get("Content-Range") != expected:
                if not (full and status == 200 and headers.get("Content-Length") == str(ref.size)):
                    raise DriveError("remote_storage_range_invalid")
            yield response

    @staticmethod
    def chunks(response, length):
        while length:
            chunk = response.read(min(256 * 1024, length))
            if not chunk:
                raise DriveError("remote_storage_incomplete")
            length -= len(chunk)
            yield chunk

    def iter_range(self, ref, start, end):
        with self.range_response(ref, start, end) as response:
            yield from self.chunks(response, end - start + 1)

    async def open_range(self, ref, start, end):
        stream = self.iter_range(ref, start, end)
        try:
            while (chunk := await anyio.to_thread.run_sync(next, stream, None)) is not None:
                yield chunk
        finally:
            with anyio.CancelScope(shield=True):
                await anyio.to_thread.run_sync(stream.close)

    def materialize(self, ref, cache_store):
        return cache_store(self, ref)

    def upload_stream(self, folder_id, rel_path, stream, size, mime_type):
        self.writable()
        for name in rel_path.parts[:-1]:
            query = f" and mimeType='{FOLDER}'"
            existing = next(
                (item for item in self.children(folder_id, query) if item["name"] == name), None
            )
            folder_id = (existing or self.create_folder(name, folder_id))["id"]
        url = self.url("/upload/drive/v3/files", {"uploadType": "resumable", "fields": FIELDS})
        with self.response(
            url,
            "POST",
            json.dumps(
                {
                    "name": rel_path.name,
                    "parents": [self.file_id(folder_id)],
                }
            ).encode(),
            {
                "Content-Type": "application/json",
                "X-Upload-Content-Type": mime_type,
                "X-Upload-Content-Length": str(size),
            },
        ) as (_, headers, _):
            session = urlsplit(headers.get("Location", ""))
        base = urlsplit(self.base)
        if (
            (session.scheme, session.netloc) != (base.scheme, base.netloc)
            or session.path != "/upload/drive/v3/files"
            or session.fragment
        ):
            raise DriveError("remote_storage_invalid_upload_session")
        # The scheme, authority and path always come from the configured Drive endpoint.
        url = f"{self.base}/upload/drive/v3/files?{session.query}"
        offset = 0
        failures = 0
        while offset < size:
            stream.seek(offset)
            chunk = stream.read(min(CHUNK, size - offset))
            if not chunk:
                raise DriveError("remote_storage_incomplete")
            end = offset + len(chunk) - 1
            try:
                with self.response(
                    url,
                    "PUT",
                    chunk,
                    {
                        "Content-Type": mime_type,
                        "Content-Range": f"bytes {offset}-{end}/{size}",
                    },
                    resumable=True,
                ) as (status, headers, response):
                    if status != 308:
                        return RemoteObject.from_drive(self.decode(response))
                    received = headers.get("Range", "")
            except DriveError as error:
                if error.code != "remote_storage_unavailable":
                    raise
                with self.response(
                    url,
                    "PUT",
                    b"",
                    {
                        "Content-Range": f"bytes */{size}",
                    },
                    resumable=True,
                ) as (status, headers, response):
                    if status != 308:
                        return RemoteObject.from_drive(self.decode(response))
                    received = headers.get("Range", "")
            match = re.fullmatch(r"bytes=0-(\d{1,20})", received)
            resume = int(match[1]) + 1 if match else 0
            failures = failures + 1 if resume <= offset else 0
            if failures >= 3 or resume > end + 1:
                break
            offset = resume
        raise DriveError("remote_storage_incomplete")


def oauth_request(base, path, fields, network):
    try:
        _, _, data = request_bytes(
            Request(
                f"{base}{path}",
                data=urlencode(fields).encode(),
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            ),
            service="gdrive_oauth",
            **network(),
        )
        return json.loads(data) if data else {}
    except HTTPError as error:
        if error.code == 400:
            error.close()
            raise DriveError("remote_storage_auth_required", 400) from None
        raise translate(error) from None
    except OutboundError as error:
        raise translate(error) from None
    except ValueError:
        raise DriveError("remote_storage_invalid_response") from None
