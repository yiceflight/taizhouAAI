#!/usr/bin/env python3
"""Check or log into Airins without printing credentials or response bodies."""

import argparse
from datetime import datetime, timezone
import getpass
import http.cookiejar
import json
import os
from pathlib import Path
import tempfile
import urllib.error
import urllib.request

BASE = "https://api-aai.airins.cn/api/mets/total"
SESSION = Path(__file__).resolve().parents[1] / ".secrets" / "airins-cookies.txt"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def request(opener, path, data=None):
    req = urllib.request.Request(
        BASE + path,
        data=None if data is None else json.dumps(data).encode(),
        headers={
            "Content-Type": "application/json",
            "Origin": "https://aai.airins.cn",
            "Referer": "https://aai.airins.cn/",
            "User-Agent": "TaizhouAAI-SessionProbe/1.0",
        },
    )
    with opener.open(req, timeout=20) as response:
        result = json.load(response)
        if not isinstance(result, dict):
            raise ValueError("Unexpected response format")
        return result


def save(jar):
    SESSION.parent.mkdir(mode=0o700, exist_ok=True)
    os.chmod(SESSION.parent, 0o700)
    fd, temporary = tempfile.mkstemp(prefix="airins-", dir=SESSION.parent)
    os.close(fd)
    try:
        jar.save(temporary, ignore_discard=True, ignore_expires=False)
        os.replace(temporary, SESSION)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["check", "login"], nargs="?", default="check")
    args = parser.parse_args()
    jar = http.cookiejar.MozillaCookieJar()
    if args.action == "check" and SESSION.exists():
        jar.load(str(SESSION), ignore_discard=True, ignore_expires=False)
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPCookieProcessor(jar))
    if args.action == "login":
        account = input("Airins account: ").strip()
        password = getpass.getpass("Airins password: ")
        result = request(opener, "/account/user/login/pwd", {"account": account, "password": password})
        del password
        if result.get("isSuccess") is not True:
            print(json.dumps({"authenticated": False, "reason": "login_rejected"}))
            return 1
    result = request(opener, "/account/user/i/s/account")
    authenticated = result.get("isSuccess") is True
    if authenticated:
        save(jar)
    metadata = [
        {
            "name": cookie.name,
            "domain": cookie.domain,
            "secure": cookie.secure,
            "expiresUtc": datetime.fromtimestamp(cookie.expires, timezone.utc).isoformat()
            if cookie.expires is not None else None,
        }
        for cookie in jar
    ]
    print(json.dumps({"authenticated": authenticated, "cookies": metadata}, ensure_ascii=False))
    return 0 if authenticated else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except urllib.error.HTTPError as error:
        print(json.dumps({"authenticated": None, "error": "http_error", "status": error.code}))
        raise SystemExit(2)
    except (OSError, ValueError, http.cookiejar.LoadError):
        print(json.dumps({"authenticated": None, "error": "network_or_session_file_error"}))
        raise SystemExit(2)
