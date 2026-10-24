#!/usr/bin/env python3
"""CLI utility to upload audio files or entire music folders to a WildString server."""

import argparse
import http.cookiejar
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from uuid import uuid4

SUPPORTED_AUDIO_EXT = {".mp3", ".flac", ".m4a", ".wav"}
SUPPORTED_SIDECAR_EXT = {".lrc", ".lryc", ".txt"}
ALL_SUPPORTED_EXT = SUPPORTED_AUDIO_EXT | SUPPORTED_SIDECAR_EXT


def format_bytes(num_bytes: int) -> str:
    if num_bytes < 1024:
        return f"{num_bytes} B"
    if num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.1f} KB"
    return f"{num_bytes / (1024 * 1024):.1f} MB"


def encode_multipart(
    fields: dict[str, str], file_field: str, filename: str, content: bytes
) -> tuple[bytes, str]:
    boundary = uuid4().hex
    body = bytearray()
    for name, value in fields.items():
        body.extend(f"--{boundary}\r\n".encode())
        body.extend(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        body.extend(f"{value}\r\n".encode())
    body.extend(f"--{boundary}\r\n".encode())
    body.extend(
        f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'.encode()
    )
    body.extend(b"Content-Type: application/octet-stream\r\n\r\n")
    body.extend(content)
    body.extend(b"\r\n")
    body.extend(f"--{boundary}--\r\n".encode())
    return bytes(body), f"multipart/form-data; boundary={boundary}"


class WildStringClient:
    def __init__(self, server: str, token: str | None = None):
        self.server = server.rstrip("/")
        self.token = token
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))

    def login(self, username: str, password: str) -> bool:
        login_url = f"{self.server}/api/v1/auth/login"
        payload = json.dumps({"username": username, "password": password}).encode("utf-8")
        req = urllib.request.Request(
            login_url,
            data=payload,
            headers={"Content-Type": "application/json", "X-Wildstring-Client": "web"},
            method="POST",
        )
        try:
            with self.opener.open(req) as resp:
                return resp.status in (200, 204)
        except urllib.error.HTTPError as err:
            sys.stderr.write(f"登录失败 ({err.code}): {err.read().decode('utf-8', 'ignore')}\n")
            return False

    def upload_file(
        self,
        file_path: Path,
        relative_path: str,
        *,
        override_artist: str | None = None,
        override_album: str | None = None,
        auto_scan: bool = False,
    ) -> dict:
        url = f"{self.server}/api/v1/manage/library/upload"
        fields = {"relative_path": relative_path}
        if auto_scan:
            fields["auto_scan"] = "true"
        if override_artist:
            fields["override_artist"] = override_artist
        if override_album:
            fields["override_album"] = override_album

        content = file_path.read_bytes()
        body, content_type = encode_multipart(fields, "file", file_path.name, content)

        headers = {
            "Content-Type": content_type,
            "X-Wildstring-Client": "web",
            "Content-Length": str(len(body)),
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"

        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with self.opener.open(req) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            raw = err.read().decode("utf-8", "ignore")
            try:
                err_data = json.loads(raw)
                message = err_data.get("detail", str(err))
            except Exception:
                message = raw or str(err)
            raise RuntimeError(f"HTTP {err.code}: {message}") from err


def collect_files(target: Path) -> list[tuple[Path, str]]:
    """Scan file or directory, returning list of (absolute_path, relative_path)."""
    if target.is_file():
        if target.suffix.lower() in ALL_SUPPORTED_EXT:
            return [(target, target.name)]
        return []

    results = []
    base = target.resolve()
    for root, _, files in os.walk(base):
        for name in files:
            path = Path(root) / name
            if path.suffix.lower() in ALL_SUPPORTED_EXT:
                rel = path.relative_to(base).as_posix()
                results.append((path, rel))
    results.sort(key=lambda item: (item[0].suffix.lower() in SUPPORTED_SIDECAR_EXT, item[1]))
    return results


def main():
    parser = argparse.ArgumentParser(
        description="Upload audio files or folders to WildString server."
    )
    parser.add_argument("path", help="Local music file or folder path to upload")
    parser.add_argument(
        "--server",
        "-s",
        default=os.environ.get("WILDSTRING_SERVER", "http://127.0.0.1:8000"),
        help="WildString server URL (default: http://127.0.0.1:8000)",
    )
    parser.add_argument(
        "--token",
        "-t",
        default=os.environ.get("WILDSTRING_TOKEN"),
        help="Access token (or set WILDSTRING_TOKEN env)",
    )
    parser.add_argument("--user", "-u", help="Login username if token is not provided")
    parser.add_argument("--password", "-p", help="Login password")
    parser.add_argument("--override-artist", help="Explicit override for artist name")
    parser.add_argument("--override-album", help="Explicit override for album name")
    parser.add_argument(
        "--dry-run", action="store_true", help="Preview matched files and exit without uploading"
    )
    parser.add_argument(
        "--no-scan", action="store_true", help="Do not trigger incremental scan after upload"
    )

    args = parser.parse_args()
    target_path = Path(args.path).resolve()
    if not target_path.exists():
        sys.stderr.write(f"错误: 目标路径不存在: {target_path}\n")
        sys.exit(1)

    matched = collect_files(target_path)
    if not matched:
        print("未找到任何受支持的音频或歌词文件。")
        sys.exit(0)

    total_bytes = sum(p.stat().st_size for p, _ in matched)
    audio_count = sum(1 for p, _ in matched if p.suffix.lower() in SUPPORTED_AUDIO_EXT)
    sidecar_count = len(matched) - audio_count

    print(f"🔍 扫描目标: {target_path}")
    print(
        f"📦 发现 {audio_count} 个音频文件，{sidecar_count} 个伴随文件，总计 {format_bytes(total_bytes)}"
    )

    if args.dry_run:
        print("\n--- 待上传清单 (Dry-run) ---")
        for p, rel in matched:
            print(f"  • [{format_bytes(p.stat().st_size):>8}] {rel}")
        print("\nDry-run 模式结束，未执行上传。")
        sys.exit(0)

    client = WildStringClient(args.server, token=args.token)
    if not args.token and args.user:
        pwd = args.password
        if not pwd:
            import getpass

            pwd = getpass.getpass(f"请输入用户 '{args.user}' 的密码: ")
        print(f"🔐 正在登录服务器 {args.server} ...")
        if not client.login(args.user, pwd):
            sys.exit(1)
        print("✓ 登录成功！\n")

    start_time = time.monotonic()
    imported_count = 0
    duplicate_count = 0
    error_count = 0

    print("🚀 开始上传:")
    for index, (file_path, rel_path) in enumerate(matched, 1):
        size_str = format_bytes(file_path.stat().st_size)
        is_last = index == len(matched)
        auto_scan = not args.no_scan and is_last

        sys.stdout.write(f"  [{index:>2}/{len(matched)}] 上传中: {rel_path} ({size_str}) ... ")
        sys.stdout.flush()

        try:
            res = client.upload_file(
                file_path,
                rel_path,
                override_artist=args.override_artist,
                override_album=args.override_album,
                auto_scan=auto_scan,
            )
            status = res.get("status")
            if status == "duplicate":
                duplicate_count += 1
                sys.stdout.write("✓ [重复跳过]\n")
            else:
                imported_count += 1
                target = res.get("target_path", "")
                sys.stdout.write(f"✓ [已导入] -> {target}\n" if target else "✓ [已导入]\n")
        except Exception as err:
            error_count += 1
            sys.stdout.write(f"✕ [失败: {err}]\n")

    elapsed = time.monotonic() - start_time
    print(
        f"\n🎉 上传完成! 成功导入 {imported_count} 首, 跳过重复 {duplicate_count} 首, 失败 {error_count} 项, 耗时 {elapsed:.1f}s。"
    )


if __name__ == "__main__":
    main()
