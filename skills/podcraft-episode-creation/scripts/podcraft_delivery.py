"""Delivery verification: episode audio, RSS items, imported bytes, and OPML exports."""

from __future__ import annotations

import argparse
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from podcraft_client import (
    ClientError,
    HttpResponse,
    PodcraftClient,
    TransportError,
    print_json,
    redact_url,
)
from podcraft_media import Probe, inspect_source, run_ffprobe

ITUNES = "{http://www.itunes.com/dtds/podcast-1.0.dtd}"
SUFFIX_BYTES = 64 * 1024
MAX_FEED_BYTES = 32 * 1024 * 1024
DURATION_TOLERANCE_SECONDS = 1.0


def as_int(value: Any) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def parse_feed(body: bytes) -> list[dict[str, Any]]:
    try:
        root = ET.fromstring(body)
    except ET.ParseError as error:
        raise ClientError(f"Feed is not valid XML: {error}") from error
    items = []
    for item in root.iter("item"):
        enclosure = item.find("enclosure")
        items.append({
            "guid": (item.findtext("guid") or "").strip(),
            "title": item.findtext("title"),
            "episodeNumber": as_int(item.findtext(f"{ITUNES}episode")),
            "enclosure": None if enclosure is None else {
                "url": enclosure.get("url"),
                "length": as_int(enclosure.get("length")),
                "type": enclosure.get("type"),
            },
        })
    return items


def feed_item_problems(
    items: list[dict[str, Any]], episode: dict[str, Any]
) -> tuple[dict | None, list[str]]:
    matches = [item for item in items if item["guid"] == episode.get("id")]
    if len(matches) != 1:
        return None, [f"found {len(matches)} items with GUID {episode.get('id')}"]
    item = matches[0]
    problems = []
    if item["episodeNumber"] != episode.get("episodeNumber"):
        problems.append(f"itunes:episode is {item['episodeNumber']}")
    enclosure = item["enclosure"] or {}
    if enclosure.get("length") != episode.get("audioSize"):
        problems.append(f"enclosure length is {enclosure.get('length')}")
    if enclosure.get("type") != episode.get("audioMimeType"):
        problems.append(f"enclosure type is {enclosure.get('type')}")
    if not str(enclosure.get("url") or "").endswith(f"/api/episodes/{episode.get('id')}/audio"):
        problems.append("enclosure URL does not name this episode's audio")
    return item, problems


def try_fetch(client: PodcraftClient, url: str, **options: Any) -> HttpResponse | str:
    """Fetch, or return the transport error text for a gate problem."""
    try:
        return client.fetch(url, **options)
    except TransportError as error:
        return str(error)


def first_byte_ok(response: HttpResponse, size: Any) -> bool:
    return (
        response.status == 206
        and response.length == 1
        and response.headers.get("content-range") == f"bytes 0-0/{size}"
    )


def audio_checks(
    client: PodcraftClient, target: str, size: Any
) -> tuple[dict[str, bool], dict[str, Any], HttpResponse]:
    head = client.fetch(target, method="HEAD")
    full = client.fetch(target, digest=True)
    first = client.fetch(target, headers={"Range": "bytes=0-0"}, max_bytes=1024)
    expected_length = str(size)
    gates = {
        "audioHead": head.status == 200
        and head.headers.get("content-length") == expected_length
        and head.headers.get("accept-ranges") == "bytes",
        "audioGet": full.status == 200
        and full.length == size
        and full.headers.get("content-length") == expected_length
        and full.headers.get("accept-ranges") == "bytes",
        "audioRange": first_byte_ok(first, size),
    }
    details = {
        "head": {"status": head.status, "contentLength": head.headers.get("content-length"),
                 "acceptRanges": head.headers.get("accept-ranges"),
                 "contentType": head.headers.get("content-type")},
        "get": {"status": full.status, "bytes": full.length, "sha256": full.sha256},
        "range": {"status": first.status, "bytes": first.length,
                  "contentRange": first.headers.get("content-range")},
    }
    return gates, details, full


def import_checks(
    client: PodcraftClient,
    target: str,
    episode: dict[str, Any],
    source: dict[str, Any],
    served: HttpResponse,
    content_type: str | None,
) -> tuple[dict[str, bool], dict[str, Any]]:
    size = source["bytes"]
    tail_length = min(SUFFIX_BYTES, size)
    with open(source["path"], "rb") as handle:
        handle.seek(size - tail_length)
        tail = handle.read()
    suffix = client.fetch(target, headers={"Range": f"bytes=-{tail_length}"}, max_bytes=tail_length + 1)
    beyond = client.fetch(target, headers={"Range": f"bytes={size}-"}, max_bytes=1024)
    duration = episode.get("audioDuration")
    gates = {
        "importMime": episode.get("audioMimeType") == source["mimeType"]
        and (content_type or "").split(";")[0].strip() == source["mimeType"],
        "importSize": size == episode.get("audioSize") == served.length,
        "importDuration": isinstance(duration, (int, float))
        and abs(duration - source["duration"]) <= DURATION_TOLERANCE_SECONDS,
        "importSha256": source["sha256"] == episode.get("audioSha256") == served.sha256,
        "suffixRange": suffix.status == 206
        and suffix.body == tail
        and suffix.headers.get("content-range") == f"bytes {size - tail_length}-{size - 1}/{size}",
        "outOfRange": beyond.status == 416
        and beyond.headers.get("content-range") == f"bytes */{size}",
    }
    details = {
        "source": source,
        "sha256": {"source": source["sha256"], "stored": episode.get("audioSha256"),
                   "served": served.sha256},
        "durationSeconds": {"source": source["duration"], "stored": duration},
        "suffixRange": {"status": suffix.status, "bytes": suffix.length,
                        "contentRange": suffix.headers.get("content-range")},
        "outOfRange": {"status": beyond.status, "contentRange": beyond.headers.get("content-range")},
    }
    return gates, details


def provenance_problems(episode: dict[str, Any], args: argparse.Namespace) -> list[str]:
    problems = []
    if episode.get("sourceType") != "imported":
        problems.append(f"sourceType is {episode.get('sourceType')}")
    if (episode.get("script") or "").strip():
        problems.append("script is not empty")
    if args.source_id and episode.get("sourceId") != args.source_id:
        problems.append(f"sourceId is {episode.get('sourceId')!r}")
    return problems


def verify_episode(
    client: PodcraftClient, args: argparse.Namespace, probe: Probe = run_ffprobe
) -> tuple[dict[str, Any], bool]:
    episode_id = args.episode_id
    episode = client.episode(episode_id)
    slug = (episode.get("series") or {}).get("slug")
    if not slug:
        raise ClientError("episode.get returned no series slug")

    quoted = urllib.parse.quote(episode_id)
    audio_path = f"/api/episodes/{quoted}/audio"
    feed_path = f"/api/feed/{urllib.parse.quote(str(slug))}"
    size = episode.get("audioSize")
    problems: dict[str, list[str]] = {}

    page = client.fetch(f"/episodes/{quoted}", method="HEAD")
    audio_gates, audio_details, served = audio_checks(client, audio_path, size)
    feed = client.fetch(feed_path, max_bytes=MAX_FEED_BYTES)
    item = None
    if feed.status == 200:
        item, problems["feedItem"] = feed_item_problems(parse_feed(feed.body), episode)
    else:
        problems["feedItem"] = [f"feed returned HTTP {feed.status}"]
    enclosure_url = ((item or {}).get("enclosure") or {}).get("url")
    enclosure = (
        try_fetch(client, enclosure_url, headers={"Range": "bytes=0-0"}, max_bytes=1024)
        if enclosure_url else None
    )
    if isinstance(enclosure, str):
        problems["enclosureRange"] = [enclosure]
        enclosure = None

    duration = episode.get("audioDuration")
    gates: dict[str, bool] = {
        "production": episode.get("status") == "ready"
        and bool(episode.get("id"))
        and isinstance(duration, (int, float)) and duration > 0
        and isinstance(size, int) and size > 0
        and bool(episode.get("audioPath"))
        and not episode.get("error"),
        "episodePage": page.status == 200,
        **audio_gates,
        "seriesFeed": feed.status == 200 and item is not None,
        "feedItem": item is not None and not problems["feedItem"],
        "enclosureRange": enclosure is not None and first_byte_ok(enclosure, size),
    }
    if args.episode_number is not None:
        gates["episodeNumber"] = episode.get("episodeNumber") == args.episode_number
    if episode.get("audioSha256"):
        gates["storedSha256"] = episode["audioSha256"] == served.sha256

    details: dict[str, Any] = {"audio": audio_details}
    imported = episode.get("sourceType") == "imported" or args.source or args.source_id
    if imported:
        problems["importProvenance"] = provenance_problems(episode, args)
        gates["importProvenance"] = not problems["importProvenance"]
        gates["importSource"] = bool(args.source)
        if args.source:
            source = inspect_source(args.source, probe)
            byte_gates, details["import"] = import_checks(
                client, audio_path, episode, source, served,
                audio_details["head"]["contentType"],
            )
            gates.update(byte_gates)
        else:
            problems["importSource"] = ["pass --source with the original file"]

    result = {
        "episodeId": episode_id,
        "status": episode.get("status"),
        "sourceType": episode.get("sourceType"),
        "episodeNumber": episode.get("episodeNumber"),
        "duration": duration,
        "error": episode.get("error"),
        "failedStep": episode.get("failedStep"),
        "urls": {
            "episode": client.url(f"/episodes/{quoted}"),
            "audio": client.url(audio_path),
            "feed": client.url(feed_path),
            "enclosure": redact_url(enclosure_url) if enclosure_url else None,
        },
        "gates": gates,
        "failedGates": [name for name, passed in gates.items() if not passed],
        "problems": {key: value for key, value in problems.items() if value},
        "audioResponse": audio_details["range"],
        "feedItem": item,
        "details": details,
    }
    if result["feedItem"] and result["feedItem"].get("enclosure"):
        result["feedItem"]["enclosure"]["url"] = redact_url(enclosure_url)
    return result, all(gates.values())


def cmd_verify(
    client: PodcraftClient, args: argparse.Namespace, probe: Probe = run_ffprobe
) -> int:
    result, passed = verify_episode(client, args, probe)
    print_json(result)
    return 0 if passed else 1


# OPML ----------------------------------------------------------------------


def parse_opml(body: bytes) -> list[dict[str, Any]]:
    try:
        root = ET.fromstring(body)
    except ET.ParseError as error:
        raise ClientError(f"OPML is not valid XML: {error}") from error
    if root.tag != "opml":
        raise ClientError(f"Root element is {root.tag}, not opml")
    outlines = []
    for node in root.iter("outline"):
        if node.get("xmlUrl") is None and node.get("type") is None:
            continue  # a grouping outline
        url = node.get("xmlUrl") or ""
        path = urllib.parse.urlsplit(url).path
        marker = path.rfind("/api/feed")
        slug = None
        if marker >= 0:
            rest = path[marker + len("/api/feed"):].strip("/")
            slug = urllib.parse.unquote(rest) if rest else "(combined)"
        outlines.append({
            "type": node.get("type"),
            "text": node.get("text"),
            "title": node.get("title"),
            "xmlUrl": url,
            "slug": slug,
        })
    return outlines


def check_episode_delivery(
    client: PodcraftClient, episode_id: str, feeds: dict[str, list[dict[str, Any]]]
) -> dict[str, Any]:
    episode = client.episode(episode_id)
    slug = (episode.get("series") or {}).get("slug")
    feed_items = feeds.get(slug) or feeds.get("(combined)")
    if feed_items is None:
        return {"episodeId": episode_id, "series": slug, "ok": False,
                "problems": ["no checked feed for this series"]}
    item, problems = feed_item_problems(feed_items, episode)
    enclosure_url = ((item or {}).get("enclosure") or {}).get("url")
    if enclosure_url:
        response = try_fetch(client, enclosure_url, headers={"Range": "bytes=0-0"}, max_bytes=1024)
        if isinstance(response, str):
            problems.append(response)
        elif not first_byte_ok(response, episode.get("audioSize")):
            problems.append(f"enclosure range returned HTTP {response.status}")
    return {"episodeId": episode_id, "series": slug, "ok": not problems, "problems": problems}


def cmd_opml_check(client: PodcraftClient, args: argparse.Namespace) -> int:
    if not args.url and not args.file:
        raise ClientError("opml-check needs --url, --file, or both")
    gates: dict[str, bool] = {}
    report: dict[str, Any] = {}
    file_bytes = None
    if args.file:
        path = Path(args.file).expanduser().resolve()
        try:
            file_bytes = path.read_bytes()
        except OSError as error:
            raise ClientError(f"Cannot read {path}: {error}") from error
        report["file"] = str(path)
    body = file_bytes
    if args.url:
        response = client.fetch(args.url, max_bytes=MAX_FEED_BYTES)
        filename = args.expect_filename or Path(
            urllib.parse.urlsplit(args.url).path).name
        disposition = response.headers.get("content-disposition", "")
        gates["downloadStatus"] = response.status == 200
        gates["attachment"] = disposition == f'attachment; filename="{filename}"'
        gates["contentType"] = response.headers.get("content-type") == "application/octet-stream"
        gates["cacheControl"] = response.headers.get("cache-control") == "private, no-store"
        report["download"] = {
            "url": redact_url(args.url),
            "status": response.status,
            "contentDisposition": disposition,
            "contentType": response.headers.get("content-type"),
            "cacheControl": response.headers.get("cache-control"),
        }
        if file_bytes is not None:
            gates["matchesFile"] = response.body == file_bytes
        body = response.body

    outlines = parse_opml(body or b"")
    gates["outlinesComplete"] = bool(outlines) and all(
        item["type"] == "rss" and item["text"] and item["title"] and item["xmlUrl"]
        for item in outlines
    )
    slugs = [item["slug"] for item in outlines]
    if args.expect_slug:
        gates["expectedFeeds"] = sorted(slugs) == sorted(args.expect_slug)

    feeds: dict[str, list[dict[str, Any]]] = {}
    if args.check_feeds or args.expect_episode:
        for item in outlines:
            response = try_fetch(client, item["xmlUrl"], max_bytes=MAX_FEED_BYTES)
            if isinstance(response, str):
                item["feedError"] = response
                continue
            item["feedStatus"] = response.status
            if response.status == 200:
                try:
                    feeds[item["slug"]] = parse_feed(response.body)
                    item["feedItems"] = len(feeds[item["slug"]])
                except ClientError as error:
                    item["feedError"] = str(error)
        gates["feedsReachable"] = all(item["slug"] in feeds for item in outlines)
    if args.expect_episode:
        report["episodes"] = [
            check_episode_delivery(client, episode_id, feeds) for episode_id in args.expect_episode
        ]
        gates["episodesDelivered"] = all(entry["ok"] for entry in report["episodes"])

    for item in outlines:
        item["xmlUrl"] = redact_url(item["xmlUrl"])
    report["outlines"] = outlines
    report["gates"] = gates
    report["failedGates"] = [name for name, passed in gates.items() if not passed]
    print_json(report)
    return 0 if all(gates.values()) else 1
