"""BYO OAuth credentials and session-bound, single-use authorization."""

import json
import os
import secrets
import time
from functools import partial
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock
from urllib.parse import urlencode
from uuid import uuid4

from fastapi import HTTPException

from wildstring.auth import token_hash
from wildstring.library.repository import now
from wildstring.storage.gdrive import DriveError, GoogleDrive, oauth_request

CALLBACK = "/api/v1/remote-storage/callback"
SCOPES = {
    "drive_file": "https://www.googleapis.com/auth/drive.file",
    "drive_readonly": "https://www.googleapis.com/auth/drive.readonly",
}


def drive_http_error(error):
    if error.code == "remote_storage_read_only":
        return HTTPException(409, error.code)
    if error.code in {"remote_storage_folder_invalid", "remote_storage_file_not_found"}:
        return HTTPException(422, error.code)
    headers = {"Retry-After": str(error.retry_after)} if error.retry_after is not None else None
    return HTTPException(503, error.code, headers=headers)


class Accounts:
    def __init__(
        self,
        database,
        providers,
        *,
        drive_base="https://www.googleapis.com",
        oauth_base="https://oauth2.googleapis.com",
    ):
        self.db, self.providers = database, providers
        self.root = database.path.parent / "storage-secrets"
        self.drive_base, self.oauth_base = drive_base, oauth_base
        self.lock = Lock()

    def network(self):
        with self.db.connect(scoped=False) as db:
            mode = db.execute("SELECT proxy_mode FROM provider_settings WHERE id=1").fetchone()[0]
        return {
            "proxy_mode": mode,
            "proxy_url": self.providers.secrets().get("proxy_url") if mode == "custom" else None,
        }

    @staticmethod
    def public(row):
        return {
            key: row[key]
            for key in (
                "id",
                "provider",
                "name",
                "scope_mode",
                "client_id",
                "account_email",
                "status",
                "last_error",
                "created_at",
                "updated_at",
                "version",
            )
        }

    def listing(self):
        with self.db.connect(scoped=False) as db:
            return [
                self.public(row)
                for row in db.execute("SELECT * FROM remote_storage_accounts ORDER BY name,id")
            ]

    def account(self, identity):
        with self.db.connect(scoped=False) as db:
            row = db.execute(
                "SELECT * FROM remote_storage_accounts WHERE id=?", (identity,)
            ).fetchone()
        if row is None:
            raise HTTPException(404, "remote_storage_account_not_found")
        return dict(row)

    def save_secret(self, name, value):
        self.root.mkdir(mode=0o700, exist_ok=True)
        with NamedTemporaryFile(dir=self.root, delete=False, mode="w", encoding="utf-8") as stream:
            path = Path(stream.name)
            try:
                os.chmod(path, 0o600)
                json.dump(value, stream)
                stream.flush()
                os.fsync(stream.fileno())
                path.replace(self.root / name)
            finally:
                path.unlink(missing_ok=True)

    def read_secret(self, name):
        try:
            return json.loads((self.root / name).read_text())
        except FileNotFoundError:
            return {}

    def create(self, body):
        identity = uuid4().hex
        secret_ref, token_ref = f"{identity}.client", f"{identity}.token"
        self.save_secret(secret_ref, {"client_secret": body.client_secret.get_secret_value()})
        stamp = now()
        with self.db.connect(write=True) as db:
            db.execute(
                """INSERT INTO remote_storage_accounts
                   (id,name,scope_mode,client_id,secret_ref,token_ref,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (
                    identity,
                    body.name,
                    body.scope_mode,
                    body.client_id,
                    secret_ref,
                    token_ref,
                    stamp,
                    stamp,
                ),
            )
        return self.public(self.account(identity))

    def begin(self, identity, session, redirect):
        account = self.account(identity)
        state = secrets.token_urlsafe(32)
        with self.db.connect(write=True) as db:
            db.execute("DELETE FROM remote_oauth_states WHERE expires_at<=?", (time.time(),))
            db.execute(
                "INSERT INTO remote_oauth_states VALUES (?,?,?,?,?)",
                (token_hash(state), token_hash(session), identity, redirect, time.time() + 600),
            )
        parameters = {
            "client_id": account["client_id"],
            "redirect_uri": redirect,
            "response_type": "code",
            "scope": SCOPES[account["scope_mode"]],
            "access_type": "offline",
            "prompt": "consent",
            "state": state,
        }
        return {
            "authorization_url": f"https://accounts.google.com/o/oauth2/v2/auth?{urlencode(parameters)}"
        }

    def change_status(self, account, code=None):
        status = "auth_required" if code == "remote_storage_auth_required" else account["status"]
        if status != account["status"] or code != account["last_error"]:
            with self.db.connect(write=True) as db:
                db.execute(
                    """UPDATE remote_storage_accounts SET status=?,last_error=?,updated_at=?,
                       version=version+1 WHERE id=? AND version=?""",
                    (status, code, now(), account["id"], account["version"]),
                )

    def exchange(self, account, fields):
        secret = self.read_secret(account["secret_ref"]).get("client_secret")
        if not secret:
            raise DriveError("remote_storage_auth_required")
        result = oauth_request(
            self.oauth_base,
            "/token",
            {
                "client_id": account["client_id"],
                "client_secret": secret,
                **fields,
            },
            self.network,
        )
        if not result.get("access_token"):
            raise DriveError("remote_storage_auth_required")
        return {
            "access_token": result["access_token"],
            "refresh_token": result.get("refresh_token") or fields.get("refresh_token"),
            "expires_at": time.time() + int(result.get("expires_in", 3600)),
        }

    def finish(self, body, session, redirect):
        with self.db.connect(write=True) as db:
            state = db.execute(
                """DELETE FROM remote_oauth_states WHERE state_hash=? AND session_hash=?
                   AND redirect_uri=? AND expires_at>? RETURNING account_id""",
                (token_hash(body.state), token_hash(session), redirect, time.time()),
            ).fetchone()
        if state is None:
            raise HTTPException(400, "remote_storage_oauth_state_invalid")
        if body.code is None:
            raise HTTPException(400, "remote_storage_oauth_cancelled")
        with self.lock:
            account = self.account(state[0])
            token = self.exchange(
                account,
                {
                    "grant_type": "authorization_code",
                    "code": body.code,
                    "redirect_uri": redirect,
                },
            )
            if not token["refresh_token"]:
                raise DriveError("remote_storage_auth_required")
            drive = GoogleDrive(
                account, lambda **_: token["access_token"], self.network, base=self.drive_base
            )
            about = drive.json("/drive/v3/about", {"fields": "user(emailAddress,permissionId)"})
            user = about.get("user") if isinstance(about, dict) else None
            subject = user.get("permissionId") if isinstance(user, dict) else None
            if not isinstance(subject, str) or not subject:
                raise DriveError("remote_storage_invalid_response")
            if account["account_subject"] and account["account_subject"] != subject:
                raise HTTPException(409, "remote_storage_account_mismatch")
            self.save_secret(account["token_ref"], token)
            with self.db.connect(write=True) as db:
                db.execute(
                    """UPDATE remote_storage_accounts SET account_email=?,account_subject=?,
                       status='connected',last_error=NULL,updated_at=?,version=version+1 WHERE id=?""",
                    (user.get("emailAddress"), subject, now(), account["id"]),
                )
        return self.public(self.account(account["id"]))

    def token(self, identity, *, rejected=None):
        with self.lock:
            account = self.account(identity)
            token = self.read_secret(account["token_ref"])
            refresh = token.get("refresh_token")
            if account["status"] != "connected" or not refresh:
                raise DriveError("remote_storage_auth_required")
            access = token.get("access_token")
            expires_at = token.get("expires_at", 0)
            if access and access != rejected and expires_at > time.time() + 30:
                return access
            try:
                updated = self.exchange(
                    account, {"grant_type": "refresh_token", "refresh_token": refresh}
                )
                self.save_secret(account["token_ref"], updated)
                return updated["access_token"]
            except DriveError as error:
                self.change_status(account, error.code)
                raise

    def drive(self, identity):
        return GoogleDrive(
            self.account(identity),
            partial(self.token, identity),
            self.network,
            base=self.drive_base,
        )

    def record_failure(self, identity, error):
        self.change_status(self.account(identity), error.code)

    def revoke(self, identity):
        with self.lock:
            account = self.account(identity)
            token = self.read_secret(account["token_ref"])
            if refresh := token.get("refresh_token"):
                try:
                    oauth_request(self.oauth_base, "/revoke", {"token": refresh}, self.network)
                except DriveError as error:
                    if error.code != "remote_storage_auth_required":
                        raise
            (self.root / account["token_ref"]).unlink(missing_ok=True)
            self.change_status(account, "remote_storage_auth_required")
            with self.db.connect(write=True) as db:
                db.execute("DELETE FROM remote_oauth_states WHERE account_id=?", (identity,))
        return self.public(self.account(identity))
