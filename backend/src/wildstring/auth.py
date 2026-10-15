"""Single administrator with revocable, database-backed browser sessions."""

import hashlib
import hmac
import secrets
import time
from typing import Annotated

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field, SecretStr

from wildstring.config import Settings
from wildstring.database import Database

COOKIE = "wildstring_session"
SESSION_SECONDS = 7 * 24 * 60 * 60


def password_hash(password: str, salt: str | None = None) -> str:
    if not 12 <= len(password) <= 128 or len(password.encode()) > 512:
        raise ValueError("Password must contain 12–128 characters")
    salt = salt or secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1)
    return f"{salt}:{digest.hex()}"


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Login(BaseModel):
    username: Annotated[str, Field(max_length=128)]
    password: SecretStr = Field(min_length=1, max_length=128)


class Auth:
    def __init__(self, database: Database, settings: Settings):
        self.database = database
        self.settings = settings

    def configured(self) -> bool:
        with self.database.connect() as connection:
            return connection.execute("SELECT 1 FROM admin").fetchone() is not None

    def set_password(self, password: str, *, only_if_empty: bool = False) -> None:
        hashed = password_hash(password)
        with self.database.connect(write=True) as connection:
            if only_if_empty:
                connection.execute("INSERT OR IGNORE INTO admin VALUES (1, ?)", (hashed,))
            else:
                connection.execute("INSERT OR REPLACE INTO admin VALUES (1, ?)", (hashed,))
                connection.execute("DELETE FROM sessions")
                connection.execute("UPDATE login_guard SET failures = 0, blocked_until = 0")

    def authenticated(self, request: Request) -> bool:
        token = request.cookies.get(COOKIE, "")
        if not token or len(token) > 128:
            return False
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?",
                (token_hash(token), int(time.time())),
            ).fetchone()
        return row is not None

    def require_session(self, request: Request) -> None:
        if not self.authenticated(request):
            raise HTTPException(401, "authentication_required")

    @staticmethod
    def require_client(request: Request) -> None:
        # Cross-site forms cannot set this header; no cross-origin CORS access is enabled.
        if request.headers.get("x-wildstring-client") != "web":
            raise HTTPException(403, "client_header_required")

    def login(self, username: str, password: str) -> str:
        # One transaction serializes attempts across API processes, including password checks.
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            current = int(time.time())
            connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (current,))
            row = connection.execute("SELECT password_hash FROM admin").fetchone()
            if row is None:
                raise HTTPException(503, "admin_setup_required")
            guard = connection.execute("SELECT * FROM login_guard").fetchone()
            if guard["blocked_until"] > current:
                raise HTTPException(429, "login_throttled", headers={"Retry-After": "60"})
            salt = row[0].split(":")[0]
            try:
                valid = hmac.compare_digest(password_hash(password, salt), row[0])
            except ValueError:
                valid = False
            if username != "admin" or not valid:
                failures = guard["failures"] + 1 if guard["blocked_until"] == 0 else 1
                connection.execute(
                    "UPDATE login_guard SET failures = ?, blocked_until = ?",
                    (failures, current + 60 if failures >= 5 else 0),
                )
                # Commit failed attempts before returning the error to the caller.
                connection.commit()
                raise HTTPException(401, "invalid_credentials")
            connection.execute("UPDATE login_guard SET failures = 0, blocked_until = 0")
            token = secrets.token_urlsafe(32)
            connection.execute(
                "INSERT INTO sessions VALUES (?, ?)", (token_hash(token), current + SESSION_SECONDS)
            )
            return token

    def router(self) -> APIRouter:
        router = APIRouter(prefix="/api/v1/auth", tags=["auth"])

        @router.get("/status")
        def status(request: Request, response: Response):
            response.headers["Cache-Control"] = "no-store"
            return {"configured": self.configured(), "authenticated": self.authenticated(request)}

        @router.post("/login")
        def login(body: Login, request: Request, response: Response):
            self.require_client(request)
            token = self.login(body.username, body.password.get_secret_value())
            response.set_cookie(
                COOKIE,
                token,
                max_age=SESSION_SECONDS,
                httponly=True,
                secure=self.settings.cookie_secure,
                samesite="strict",
                path="/",
            )
            response.headers["Cache-Control"] = "no-store"
            return {"username": "admin"}

        @router.post("/logout", status_code=204)
        def logout(request: Request):
            self.require_client(request)
            with self.database.connect(write=True) as connection:
                connection.execute(
                    "DELETE FROM sessions WHERE token_hash = ?",
                    (token_hash(request.cookies.get(COOKIE, "")),),
                )
            response = Response(status_code=204, headers={"Cache-Control": "no-store"})
            response.delete_cookie(
                COOKIE,
                path="/",
                secure=self.settings.cookie_secure,
                httponly=True,
                samesite="strict",
            )
            return response

        return router
