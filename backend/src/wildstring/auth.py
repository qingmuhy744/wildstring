"""Local users, account profiles and revocable database-backed sessions."""

import hashlib
import hmac
import secrets
import time
from importlib.metadata import PackageNotFoundError, version
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError, field_validator

from wildstring.config import Settings
from wildstring.database import Database
from wildstring.permissions import require_owner, require_scope

COOKIE = "wildstring_session"
SESSION_SECONDS = 7 * 24 * 60 * 60


def password_hash(password: str, salt: str | None = None) -> str:
    if not 12 <= len(password) <= 128 or len(password.encode()) > 512:
        raise ValueError("Password must contain 12–128 characters")
    salt = salt or secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1)
    return f"{salt}:{digest.hex()}"


DUMMY_HASH = password_hash("unknown-account-password")


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Login(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=1, max_length=128)
    password: SecretStr = Field(min_length=1, max_length=128)


class PasswordChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    current_password: SecretStr = Field(min_length=1, max_length=128)
    new_password: SecretStr = Field(min_length=12, max_length=128)


class ProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    version: int = Field(ge=1, strict=True)
    username: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$")
    display_name: str = Field(default="", max_length=80)
    email: str = Field(default="", max_length=254)

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        if value and ("@" not in value or any(char.isspace() for char in value)):
            raise ValueError("invalid_email")
        return value


class UserCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$")
    password: SecretStr = Field(min_length=12, max_length=128)
    profile: Literal["owner", "librarian", "editor", "listener"] = "listener"


class UserUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1, strict=True)
    profile: Literal["owner", "librarian", "editor", "listener"]
    enabled: bool = Field(strict=True)


class PasswordReset(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1, strict=True)
    new_password: SecretStr = Field(min_length=12, max_length=128)


def validated(model, body):
    # Default validation errors include input values, including submitted secrets.
    try:
        return model.model_validate(body)
    except ValidationError:
        raise HTTPException(422, "invalid_account_input") from None


def public_user(row):
    return {
        key: row[key] for key in ("id", "username", "profile", "version", "display_name", "email")
    } | {
        "enabled": bool(row["enabled"]),
    }


def secret_hash(value):
    try:
        return password_hash(value.get_secret_value())
    except (ValueError, UnicodeError):
        raise HTTPException(422, "invalid_account_input") from None


class Auth:
    def __init__(self, database: Database, settings: Settings):
        self.database, self.settings = database, settings

    def configured(self) -> bool:
        with self.database.connect() as connection:
            return (
                connection.execute(
                    "SELECT 1 FROM users WHERE profile='owner' AND enabled=1 AND password_hash IS NOT NULL"
                ).fetchone()
                is not None
            )

    def set_password(self, password: str, *, only_if_empty: bool = False) -> None:
        hashed = password_hash(password)
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            result = connection.execute(
                "UPDATE users SET password_hash=?,profile='owner',enabled=1,version=version+1 "
                "WHERE id='admin' AND (?=0 OR password_hash IS NULL)",
                (hashed, only_if_empty),
            )
            if result.rowcount:
                connection.execute("DELETE FROM sessions WHERE user_id='admin'")
                connection.execute("UPDATE login_guard SET failures=0,blocked_until=0")

    def require_session(self, request: Request) -> dict:
        if getattr(request.state, "user", None) is not None:
            return request.state.user
        token = request.cookies.get(COOKIE, "")
        if not token or len(token) > 128:
            raise HTTPException(401, "authentication_required")
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id "
                "WHERE s.token_hash=? AND s.expires_at>? AND u.enabled=1 AND u.password_hash IS NOT NULL",
                (token_hash(token), int(time.time())),
            ).fetchone()
        if row is None:
            raise HTTPException(401, "authentication_required")
        request.state.user = public_user(row)
        return request.state.user

    def authenticated(self, request: Request) -> bool:
        try:
            self.require_session(request)
            return True
        except HTTPException:
            return False

    def require_owner(self, request: Request) -> dict:
        return require_owner(self.require_session(request))

    def require_permission(self, scope: str):
        def dependency(request: Request) -> dict:
            return require_scope(self.require_session(request), scope)

        return dependency

    @staticmethod
    def require_client(request: Request) -> None:
        if request.headers.get("x-wildstring-client") not in {"web", "android", "ios"}:
            raise HTTPException(403, "client_header_required")

    @staticmethod
    def check_owner(connection, user):
        if (
            connection.execute(
                "SELECT 1 FROM users WHERE id=? AND profile='owner' AND enabled=1", (user["id"],)
            ).fetchone()
            is None
        ):
            raise HTTPException(403, "owner_required")

    @staticmethod
    def verify_password(connection, hashed, password):
        current = int(time.time())
        guard = connection.execute("SELECT * FROM login_guard").fetchone()
        if guard["blocked_until"] > current:
            raise HTTPException(429, "login_throttled", headers={"Retry-After": "60"})
        expected = hashed or DUMMY_HASH
        try:
            valid = (
                hmac.compare_digest(password_hash(password, expected.split(":")[0]), expected)
                and hashed is not None
            )
        except (ValueError, UnicodeError):
            valid = False
        if not valid:
            failures = guard["failures"] + 1 if guard["blocked_until"] == 0 else 1
            connection.execute(
                "UPDATE login_guard SET failures=?,blocked_until=?",
                (failures, current + 60 if failures >= 5 else 0),
            )
            connection.commit()
            raise HTTPException(401, "invalid_credentials")
        connection.execute("UPDATE login_guard SET failures=0,blocked_until=0")

    def login(self, username: str, password: str) -> tuple[str, dict]:
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            if (
                connection.execute(
                    "SELECT 1 FROM users WHERE profile='owner' AND enabled=1 AND password_hash IS NOT NULL"
                ).fetchone()
                is None
            ):
                raise HTTPException(503, "owner_setup_required")
            current = int(time.time())
            connection.execute("DELETE FROM sessions WHERE expires_at<=?", (current,))
            row = connection.execute(
                "SELECT * FROM users WHERE username=? COLLATE NOCASE AND enabled=1", (username,)
            ).fetchone()
            self.verify_password(connection, row["password_hash"] if row else None, password)
            token = secrets.token_urlsafe(32)
            connection.execute(
                "INSERT INTO sessions(token_hash,expires_at,user_id) VALUES (?,?,?)",
                (token_hash(token), current + SESSION_SECONDS, row["id"]),
            )
            return token, public_user(row)

    def logout_response(self):
        response = Response(status_code=204, headers={"Cache-Control": "no-store"})
        response.delete_cookie(
            COOKIE, path="/", secure=self.settings.cookie_secure, httponly=True, samesite="strict"
        )
        return response

    def router(self) -> APIRouter:
        router = APIRouter(prefix="/api/v1/auth", tags=["auth"])

        @router.get("/status")
        def status(request: Request, response: Response):
            response.headers["Cache-Control"] = "no-store"
            authenticated = self.authenticated(request)
            try:
                server_ver = version("wildstring-backend")
            except PackageNotFoundError:
                server_ver = "0.7.0"
            result = {
                "configured": self.configured(),
                "authenticated": authenticated,
                "version": server_ver,
            }
            if authenticated:
                result["user"] = self.require_session(request)
            return result

        @router.post("/login")
        def login(request: Request, response: Response, body: object = Body(...)):
            self.require_client(request)
            value = validated(Login, body)
            token, user = self.login(value.username, value.password.get_secret_value())
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
            return user

        @router.post("/password", status_code=204)
        def change_password(request: Request, body: object = Body(...)):
            self.require_client(request)
            user = self.require_session(request)
            value = validated(PasswordChange, body)
            hashed = secret_hash(value.new_password)
            with self.database.connect(write=True) as connection:
                connection.execute("BEGIN IMMEDIATE")
                row = connection.execute(
                    "SELECT password_hash FROM users WHERE id=?", (user["id"],)
                ).fetchone()
                try:
                    self.verify_password(
                        connection, row[0], value.current_password.get_secret_value()
                    )
                except HTTPException as error:
                    if error.status_code == 401:
                        raise HTTPException(400, "current_password_incorrect") from None
                    raise
                connection.execute(
                    "UPDATE users SET password_hash=?,version=version+1 WHERE id=?",
                    (hashed, user["id"]),
                )
                connection.execute("DELETE FROM sessions WHERE user_id=?", (user["id"],))
            return self.logout_response()

        @router.put("/profile")
        def update_profile(request: Request, body: object = Body(...)):
            self.require_client(request)
            actor = self.require_session(request)
            value = validated(ProfileUpdate, body)
            with self.database.connect(write=True) as connection:
                connection.execute("BEGIN IMMEDIATE")
                row = connection.execute(
                    "SELECT * FROM users WHERE id=?", (actor["id"],)
                ).fetchone()
                if row is None or row["version"] != value.version:
                    raise HTTPException(409, "user_version_conflict")
                duplicate = connection.execute(
                    "SELECT 1 FROM users WHERE username=? COLLATE NOCASE AND id<>?",
                    (value.username, actor["id"]),
                ).fetchone()
                if duplicate:
                    raise HTTPException(409, "username_taken")
                connection.execute(
                    "UPDATE users SET username=?,display_name=?,email=?,version=version+1 WHERE id=?",
                    (value.username, value.display_name, value.email, actor["id"]),
                )
                updated = connection.execute(
                    "SELECT * FROM users WHERE id=?", (actor["id"],)
                ).fetchone()
                return public_user(updated)

        @router.post("/logout", status_code=204)
        def logout(request: Request):
            self.require_client(request)
            with self.database.connect(write=True) as connection:
                connection.execute(
                    "DELETE FROM sessions WHERE token_hash=?",
                    (token_hash(request.cookies.get(COOKIE, "")),),
                )
            return self.logout_response()

        from wildstring.avatars import router as avatar_router

        router.include_router(avatar_router(self))
        return router

    def users_router(self):
        router = APIRouter(
            prefix="/api/v1/manage/users", dependencies=[Depends(self.require_owner)]
        )

        def target(connection, user_id, version):
            row = connection.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
            if row is None:
                raise HTTPException(404, "user_not_found")
            if row["version"] != version:
                raise HTTPException(409, "user_version_conflict")
            return row

        @router.get("")
        def listing(response: Response):
            response.headers["Cache-Control"] = "no-store"
            with self.database.connect() as connection:
                return {
                    "items": [
                        public_user(row)
                        for row in connection.execute(
                            "SELECT * FROM users ORDER BY username COLLATE NOCASE"
                        )
                    ]
                }

        @router.post("", status_code=201, dependencies=[Depends(self.require_client)])
        def create(request: Request, body: object = Body(...)):
            actor, value = self.require_owner(request), validated(UserCreate, body)
            hashed = secret_hash(value.password)
            with self.database.connect(write=True) as connection:
                connection.execute("BEGIN IMMEDIATE")
                self.check_owner(connection, actor)
                if connection.execute(
                    "SELECT 1 FROM users WHERE username=?", (value.username,)
                ).fetchone():
                    raise HTTPException(409, "username_taken")
                user_id = uuid4().hex
                connection.execute(
                    "INSERT INTO users(id,username,password_hash,profile) VALUES (?,?,?,?)",
                    (user_id, value.username, hashed, value.profile),
                )
                return public_user(
                    connection.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
                )

        @router.put("/{user_id}", dependencies=[Depends(self.require_client)])
        def update(user_id: str, request: Request, body: UserUpdate):
            actor = self.require_owner(request)
            with self.database.connect(write=True) as connection:
                connection.execute("BEGIN IMMEDIATE")
                self.check_owner(connection, actor)
                target(connection, user_id, body.version)
                if actor["id"] == user_id:
                    raise HTTPException(409, "cannot_change_self_profile")
                connection.execute(
                    "UPDATE users SET profile=?,enabled=?,version=version+1 WHERE id=?",
                    (body.profile, body.enabled, user_id),
                )
                connection.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
                return public_user(
                    connection.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
                )

        @router.post(
            "/{user_id}/password", status_code=204, dependencies=[Depends(self.require_client)]
        )
        def reset(user_id: str, request: Request, body: object = Body(...)):
            actor, value = self.require_owner(request), validated(PasswordReset, body)
            if actor["id"] == user_id:
                raise HTTPException(409, "use_self_password_change")
            hashed = secret_hash(value.new_password)
            with self.database.connect(write=True) as connection:
                connection.execute("BEGIN IMMEDIATE")
                self.check_owner(connection, actor)
                target(connection, user_id, value.version)
                connection.execute(
                    "UPDATE users SET password_hash=?,version=version+1 WHERE id=?",
                    (hashed, user_id),
                )
                connection.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))

        return router
