"""Post and manage News-tab stories by hand, from any computer.

Standard library only, so it runs with any Python 3.10+. The admin token is
read from the ``ADMIN_TOKEN`` environment variable (the same value as the
gateway's ``.env``), never from the command line, so it stays out of your
shell history::

    $env:ADMIN_TOKEN = "<the gateway's ADMIN_TOKEN>"          (PowerShell)
    export ADMIN_TOKEN=...                                    (bash)

    python news_admin.py --gateway https://<gateway> post cricket \\
        --title "India squad for the NZ Tests is out" \\
        --summary "Gill captains; Bumrah is back." \\
        --url https://www.bcci.tv/... --trending
    python news_admin.py --gateway https://<gateway> list [cricket]
    python news_admin.py --gateway https://<gateway> remove cricket <story id>
    python news_admin.py --gateway https://<gateway> clear cricket
    python news_admin.py --gateway https://<gateway> refresh [cricket ai]

``refresh`` asks Grok for those sections now (about $0.03 each); everything
else costs nothing. ``--gateway`` can also come from ``HOLO_GATEWAY_URL``.
Sections: cricket esports india world tech ai current_affairs business
football sports entertainment science jobs.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


def call(base: str, method: str, path: str, body: dict | None = None, admin: bool = True) -> dict:
    headers = {"Content-Type": "application/json", "User-Agent": "jarvis-news-admin/1"}
    if admin:
        token = os.environ.get("ADMIN_TOKEN", "")
        if not token:
            sys.exit("Set ADMIN_TOKEN first (the gateway's admin token).")
        headers["X-Admin-Token"] = token
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(base.rstrip("/") + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=900) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:500]
        sys.exit(f"{error.code}: {detail}")
    except urllib.error.URLError as error:
        sys.exit(f"Can't reach {base}: {error.reason}")


def stories(n: int) -> str:
    return f"{n} {'story' if n == 1 else 'stories'}"


def main() -> None:
    parser = argparse.ArgumentParser(description="Manage the News tab by hand.")
    parser.add_argument("--gateway", default=os.environ.get("HOLO_GATEWAY_URL", ""),
                        help="the gateway's URL (or set HOLO_GATEWAY_URL)")
    commands = parser.add_subparsers(dest="command", required=True)

    post = commands.add_parser("post", help="post one story on top of a section")
    post.add_argument("section")
    post.add_argument("--title", required=True)
    post.add_argument("--summary", default="")
    post.add_argument("--source", default="", help='who reported it (default "JARVIS")')
    post.add_argument("--url", default="")
    post.add_argument("--trending", action="store_true", help="flag it as trending")
    post.add_argument("--replace", action="store_true", help="make this the section's only story")

    show = commands.add_parser("list", help="show what the app shows, with story ids")
    show.add_argument("section", nargs="?")

    remove = commands.add_parser("remove", help="take one story down")
    remove.add_argument("section")
    remove.add_argument("id")

    clear = commands.add_parser("clear", help="empty a section")
    clear.add_argument("section")

    refresh = commands.add_parser("refresh", help="ask Grok for fresh news now (costs ~$0.03 a section)")
    refresh.add_argument("sections", nargs="*")

    args = parser.parse_args()
    if not args.gateway:
        sys.exit("Pass --gateway https://... or set HOLO_GATEWAY_URL.")
    base = args.gateway

    if args.command == "post":
        story = {"title": args.title, "summary": args.summary, "trending": args.trending}
        if args.source:
            story["source"] = args.source
        if args.url:
            story["url"] = args.url
        result = call(base, "POST", "/v1/admin/news/items",
                      {"section": args.section, "items": [story], "replace": args.replace})
        print(f"Posted to {result['section']} (id {result['posted'][0]}); the section has {stories(result['items'])}.")
    elif args.command == "list":
        query = f"?section={args.section}" if args.section else ""
        result = call(base, "GET", f"/v1/news{query}", admin=False)
        if not result.get("sections"):
            print("No news yet.")
        for section in result.get("sections", []):
            print(f"\n{section['title']} ({section['id']}), updated {section['updated_at']}")
            for story in section["items"]:
                flags = ("HAND " if story.get("manual") else "") + ("HOT " if story.get("trending") else "")
                print(f"  [{story['id']}] {flags}{story['title']}  ({story.get('source') or '-'})")
    elif args.command == "remove":
        result = call(base, "DELETE", f"/v1/admin/news/items/{args.section}/{args.id}")
        print(f"Removed. {result['section']} has {stories(result['items'])}.")
    elif args.command == "clear":
        result = call(base, "DELETE", f"/v1/admin/news/items/{args.section}")
        print(f"Cleared {result['section']} ({stories(result['removed'])}).")
    elif args.command == "refresh":
        body: dict = {"wait": True}
        if args.sections:
            body["sections"] = args.sections
        print("Asking Grok (this takes a minute or two)...")
        result = call(base, "POST", "/v1/admin/news/refresh", body)
        for section in result["sections"]:
            extra = f" ({section['error']})" if section.get("error") else ""
            print(f"  {section['section']:<16} {section['status']:<10} {stories(section['items']):<11} ${section['cost_usd']:.4f}{extra}")
        print(f"Total ${result['cost_usd']:.4f}")


if __name__ == "__main__":
    main()
