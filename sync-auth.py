"""Explicit, user-run bootstrap. No auth data is read unless --write is supplied."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys


class SyncError(Exception):
    pass


def gh(args, data=None):
    try:
        result = subprocess.run(["gh", *args], input=data, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=30,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.TimeoutExpired):
        raise SyncError("GITHUB_CLI_FAILED") from None
    if result.returncode:
        raise SyncError("GITHUB_CLI_FAILED")
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description="用户主动将 WorkBuddy 会话同步到指定仓库 Secret；不打印或落盘明文。")
    parser.add_argument("--repo", required=True, help="明确的 GitHub owner/repository")
    parser.add_argument("--write", action="store_true", help="允许读取本机登录文件、调用客户端解密，并向目标 GitHub Secret 写入")
    parser.add_argument("--allow-public", action="store_true", help="明确允许将凭据保存到公开仓库 Secrets，日志可被他人查看")
    parser.add_argument("--auth-file", help="可选：登录文件路径；不要把文件内容发到聊天")
    parser.add_argument("--exe", help="可选：WorkBuddy.exe 完整路径")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repo):
        raise SyncError("INVALID_REPOSITORY")
    if not args.write:
        print(json.dumps({"ok": True, "mode": "preview", "repository": args.repo,
                          "secrets": ["WB_ACCESS_TOKEN", "WB_REFRESH_TOKEN"], "credentials_read": False,
                          "next": "明确同意读取本机会话并上传到此仓库后添加 --write；公开仓库另需 --allow-public"}, ensure_ascii=False))
        return
    # Check the exact recipient before accessing any local credential.
    try:
        private = json.loads(gh(["repo", "view", args.repo, "--json", "isPrivate"]))["isPrivate"]
    except (ValueError, KeyError):
        raise SyncError("REPOSITORY_CHECK_FAILED") from None
    if private is not True and not args.allow_public:
        raise SyncError("PRIVATE_REPOSITORY_REQUIRED")
    root = Path(__file__).resolve().parent
    vendor = root / "vendor" / "signin.py"
    provenance = json.loads((root / "vendor" / "auth-provenance.json").read_text(encoding="utf-8"))
    if hashlib.sha256(vendor.read_bytes()).hexdigest() != provenance["sha256"]:
        raise SyncError("AUTH_ADAPTER_HASH_CHANGED")
    spec = importlib.util.spec_from_file_location("wb_auth_adapter", vendor)
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)
    if args.exe:
        os.environ["WORKBUDDY_EXE"] = args.exe
    if args.auth_file:
        os.environ["WORKBUDDY_AUTH_FILE"] = args.auth_file
    adapter._start_budget()
    auth_file, _ = adapter.find_auth_file()
    if not auth_file:
        raise SyncError("LOCAL_SESSION_MISSING")
    session = adapter.load_session_retry(auth_file)
    resolved = adapter.resolve_session(session)
    refresh = session.get("auth", {}).get("refreshToken")
    if not refresh:
        raise SyncError("LOCAL_REFRESH_TOKEN_MISSING")
    # The pinned helper validates token syntax; the encrypted field envelope is generic.
    refresh_session = dict(session, auth=dict(session["auth"], accessToken=refresh))
    refresh = adapter.resolve_session(refresh_session)["auth"]["accessToken"]
    auth = {"accessToken": resolved["auth"]["accessToken"], "refreshToken": refresh,
            "uid": resolved["account"]["uid"], "domain": "www.workbuddy.cn",
            "enterpriseId": resolved["account"].get("enterpriseId") or ""}
    if max(len(auth["accessToken"]), len(auth["refreshToken"])) > 45000:
        raise SyncError("SECRET_TOO_LARGE")
    gh(["secret", "set", "WB_ACCESS_TOKEN", "--repo", args.repo], auth["accessToken"].encode("ascii"))
    gh(["secret", "set", "WB_REFRESH_TOKEN", "--repo", args.repo], auth["refreshToken"].encode("ascii"))
    print(json.dumps({"ok": True, "result": "SECRET_SAVED", "repository": args.repo,
                      "secrets": ["WB_ACCESS_TOKEN", "WB_REFRESH_TOKEN"], "live_auth_verified": False}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Fixed error categories only; never echo exception text or child output.
        reason = str(error) if isinstance(error, SyncError) else getattr(error, "reason", "SYNC_FAILED")
        if not re.fullmatch(r"[A-Z_]{1,80}", reason or ""):
            reason = "SYNC_FAILED"
        print(json.dumps({"ok": False, "reason": reason}), file=sys.stderr)
        sys.exit(1)
