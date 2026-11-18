#!/usr/bin/env python3
"""Small, dependency-free client for the Podcraft service."""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Any

from podcraft_client import (
    DEFAULT_BASE_URL,
    ClientError,
    PodcraftClient,
    bounded,
    iter_series_episodes,
    print_json,
    read_text,
)
from podcraft_delivery import cmd_opml_check, cmd_verify
from podcraft_imports import cmd_import, cmd_reconcile

ACTIVE_STATUSES = {"pending", "generating_script", "generating_audio", "processing"}
TERMINAL_STATUSES = {"ready", "failed"}
SLUG_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
RESERVED_SLUGS = {"new", "edit", "api", "settings", "episodes"}


def series_slug(value: str) -> str:
    slug = bounded(value, "slug", 100)
    if not SLUG_PATTERN.fullmatch(slug):
        raise ClientError(
            f'Slug "{slug}" must be lowercase alphanumeric with hyphens, such as "my-series"'
        )
    if slug in RESERVED_SLUGS:
        raise ClientError(f'Slug "{slug}" is reserved by Podcraft')
    return slug


def source_summary(path: Path, text: str) -> dict[str, Any]:
    return {
        "path": str(path),
        "characters": len(text),
        "sha256": hashlib.sha256(text.encode()).hexdigest(),
    }


def validate_remote_options(
    client: PodcraftClient,
    *,
    voice: str,
    persona_id: str | None = None,
    image_url: str | None = None,
) -> None:
    voices = client.trpc("system.voices", None)
    voice_ids = (
        {item.get("id") for item in voices if isinstance(item, dict)}
        if isinstance(voices, list)
        else set()
    )
    if voice not in voice_ids:
        raise ClientError(f'Voice "{voice}" is not supported by this Podcraft service')

    if persona_id:
        personas = client.trpc("persona.list", None)
        persona_ids = (
            {item.get("id") for item in personas if isinstance(item, dict)}
            if isinstance(personas, list)
            else set()
        )
        if persona_id not in persona_ids:
            raise ClientError(f'Persona "{persona_id}" does not exist')

    if image_url:
        parsed = urllib.parse.urlparse(image_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ClientError("--image-url must be an absolute HTTP or HTTPS URL")


def reject_duplicate_byos(
    client: PodcraftClient,
    *,
    series_id: str,
    title: str,
    script: str,
    voice: str,
) -> None:
    for episode in iter_series_episodes(client, series_id):
        if (
            str(episode.get("title", "")).strip() == title
            and str(episode.get("script", "")).strip() == script
            and episode.get("voice") == voice
        ):
            raise ClientError(
                f"Duplicate BYOS submission matches episode {episode['id']}. "
                "Use --allow-duplicate only with explicit authorization."
            )


def cmd_health(client: PodcraftClient, args: argparse.Namespace) -> int:
    if args.require:
        result = client.readiness()
        checks = result.get("checks") if isinstance(result.get("checks"), dict) else {}
        failed = [
            name for name in args.require
            if not (isinstance(checks.get(name), dict) and checks[name].get("ok") is True)
        ]
        result["required"] = {"checks": args.require, "failed": failed}
        print_json(result)
        return 1 if failed else 0
    suffix = "?ready=true" if args.ready else ""
    try:
        result, status, _ = client.request(f"/api/health{suffix}")
    except ClientError as error:
        print_json({"ok": False, "error": str(error)})
        return 1
    if not isinstance(result, dict):
        raise ClientError("Health endpoint returned a non-object result")
    print_json(result)
    return 0 if status == 200 and result.get("status") == "ok" else 1


def cmd_series(client: PodcraftClient, _args: argparse.Namespace) -> int:
    print_json(client.series())
    return 0


def build_series_plan(
    client: PodcraftClient, args: argparse.Namespace
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "title": bounded(args.title, "title", 200),
        "slug": series_slug(args.slug),
        "voice": bounded(args.voice, "voice", 200),
        "category": bounded(args.category, "category", 200),
        "author": bounded(args.author, "author", 200),
    }
    if args.description is not None:
        payload["description"] = bounded(args.description, "description", 2000)
    if args.persona_id is not None:
        payload["personaId"] = bounded(args.persona_id, "persona ID", 200)
    if args.image_url is not None:
        payload["imageUrl"] = args.image_url.strip()
    if args.default:
        payload["isDefault"] = True

    validate_remote_options(
        client,
        voice=payload["voice"],
        persona_id=payload.get("personaId"),
        image_url=payload.get("imageUrl"),
    )

    existing = client.series()
    match = next(
        (item for item in existing if item.get("slug") == payload["slug"]), None
    )
    if match is not None:
        raise ClientError(
            f'Series "{payload["slug"]}" already exists with ID {match.get("id")}. '
            "Use the existing series or choose another slug."
        )

    plan: dict[str, Any] = {"procedure": "series.create", "payload": payload}
    if args.default:
        current = next((item for item in existing if item.get("isDefault")), None)
        plan["replacesDefault"] = (
            {key: current.get(key) for key in ("id", "slug", "title")}
            if current
            else None
        )
    return plan


def cmd_series_create(client: PodcraftClient, args: argparse.Namespace) -> int:
    plan = build_series_plan(client, args)
    if args.dry_run:
        print_json(plan)
        return 0
    result = client.trpc("series.create", plan["payload"], mutation=True)
    if not isinstance(result, dict) or not result.get("id"):
        raise ClientError("series.create returned no series ID; do not retry blindly")
    print_json(result)
    return 0


def cmd_voices(client: PodcraftClient, _args: argparse.Namespace) -> int:
    print_json(client.trpc("system.voices", None))
    return 0


def build_create_plan(
    client: PodcraftClient, args: argparse.Namespace
) -> tuple[dict[str, Any], dict[str, Any]]:
    series = client.resolve_series(args.series)
    voice = args.voice or series.get("voice")
    if not voice:
        raise ClientError(f'Series "{args.series}" has no configured voice')
    validate_remote_options(
        client,
        voice=voice,
        persona_id=getattr(args, "persona_id", None),
        image_url=getattr(args, "image_url", None),
    )

    if args.mode == "generated":
        topic = bounded(args.topic, "topic", 1000)
        path, summary = read_text(args.summary_file, "summary", 50_000)
        payload = {
            "mode": "generate",
            "seriesId": series["id"],
            "topic": topic,
            "length": args.length,
            "voice": voice,
            "sourceMaterial": summary,
        }
        if args.persona_id:
            payload["personaId"] = args.persona_id
        if args.image_url:
            payload["imageUrl"] = args.image_url
        plan = {
            "mode": "generated",
            "series": {key: series.get(key) for key in ("id", "slug", "title")},
            "topic": topic,
            "length": args.length,
            "voice": voice,
            "personaId": args.persona_id,
            "imageUrl": args.image_url,
            "source": source_summary(path, summary),
        }
        return payload, plan

    title = bounded(args.title, "title", 200)
    path, script = read_text(args.script_file, "script", 200_000)
    payload = {
        "mode": "byos",
        "seriesId": series["id"],
        "topic": title,
        "title": title,
        "script": script,
        "voice": voice,
    }
    plan = {
        "mode": "byos",
        "series": {key: series.get(key) for key in ("id", "slug", "title")},
        "title": title,
        "voice": voice,
        "source": source_summary(path, script),
        "allowDuplicate": args.allow_duplicate,
    }
    return payload, plan


def cmd_create(client: PodcraftClient, args: argparse.Namespace) -> int:
    payload, plan = build_create_plan(client, args)
    if args.dry_run:
        print_json(plan)
        return 0
    if args.mode == "byos" and not args.allow_duplicate:
        reject_duplicate_byos(
            client,
            series_id=payload["seriesId"],
            title=payload["title"],
            script=payload["script"],
            voice=payload["voice"],
        )
    result = client.trpc("episode.create", payload, mutation=True)
    if not isinstance(result, dict) or not result.get("id"):
        raise ClientError("episode.create returned no episode ID; do not retry blindly")
    print_json(result)
    return 0


def cmd_status(client: PodcraftClient, args: argparse.Namespace) -> int:
    print_json(client.episode(args.episode_id))
    return 0


def cmd_wait(client: PodcraftClient, args: argparse.Namespace) -> int:
    deadline = time.monotonic() + args.timeout_seconds
    previous_status = None
    while True:
        episode = client.episode(args.episode_id)
        status = episode.get("status")
        if status != previous_status:
            print(f"Podcraft episode {args.episode_id}: {status}", file=sys.stderr)
            previous_status = status
        if status in TERMINAL_STATUSES:
            print_json(episode)
            return 0 if status == "ready" else 2
        if status not in ACTIVE_STATUSES:
            print_json(episode)
            raise ClientError(f"Unknown episode status: {status}")
        if time.monotonic() >= deadline:
            print_json(episode)
            print("Wait timed out; generation was not retried.", file=sys.stderr)
            return 3
        time.sleep(args.interval_seconds)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument(
        "--base-url",
        default=os.environ.get("PODCRAFT_API_BASE_URL", DEFAULT_BASE_URL),
        help="Podcraft origin; defaults to PODCRAFT_API_BASE_URL or the current Tailscale host",
    )
    root.add_argument("--request-timeout-seconds", type=float, default=20)
    commands = root.add_subparsers(dest="command", required=True)

    health = commands.add_parser("health", help="Check service liveness or readiness")
    health.add_argument("--ready", action="store_true")
    health.add_argument(
        "--require",
        action="append",
        metavar="CHECK",
        help="Pass when these readiness checks are ok, even if others are degraded",
    )
    health.set_defaults(handler=cmd_health)

    series = commands.add_parser(
        "series", help="List existing series, or create one"
    )
    series.set_defaults(handler=cmd_series)
    series_commands = series.add_subparsers(dest="series_command")

    series_list = series_commands.add_parser("list", help="List existing series")
    series_list.set_defaults(handler=cmd_series)

    series_create = series_commands.add_parser("create", help="Create one series")
    series_create.add_argument("--title", required=True)
    series_create.add_argument("--slug", required=True)
    series_create.add_argument("--description")
    series_create.add_argument("--voice", default="af_heart")
    series_create.add_argument("--persona-id")
    series_create.add_argument("--category", default="Technology")
    series_create.add_argument("--author", default="AI Podcast")
    series_create.add_argument("--image-url")
    series_create.add_argument(
        "--default",
        action="store_true",
        help="Make this the default series; the current default loses that status",
    )
    series_create.add_argument("--dry-run", action="store_true")
    series_create.set_defaults(handler=cmd_series_create)

    voices = commands.add_parser("voices", help="List supported voices")
    voices.set_defaults(handler=cmd_voices)

    create = commands.add_parser("create", help="Create one episode")
    modes = create.add_subparsers(dest="mode", required=True)

    generated = modes.add_parser("generated", help="Create from a topic and summary")
    generated.add_argument("--series", required=True)
    generated.add_argument("--topic", required=True)
    generated.add_argument("--summary-file", required=True)
    generated.add_argument(
        "--length", choices=("short", "medium", "long", "auto"), default="medium"
    )
    generated.add_argument("--voice")
    generated.add_argument("--persona-id")
    generated.add_argument("--image-url")
    generated.add_argument("--dry-run", action="store_true")
    generated.set_defaults(handler=cmd_create)

    byos = modes.add_parser("byos", help="Create from an authoritative script")
    byos.add_argument("--series", required=True)
    byos.add_argument("--title", required=True)
    byos.add_argument("--script-file", required=True)
    byos.add_argument("--voice")
    byos.add_argument("--allow-duplicate", action="store_true")
    byos.add_argument("--dry-run", action="store_true")
    byos.set_defaults(handler=cmd_create)

    status = commands.add_parser("status", help="Get one episode")
    status.add_argument("episode_id")
    status.set_defaults(handler=cmd_status)

    wait = commands.add_parser("wait", help="Poll until ready or failed")
    wait.add_argument("episode_id")
    wait.add_argument("--timeout-seconds", type=float, default=3600)
    wait.add_argument("--interval-seconds", type=float, default=10)
    wait.set_defaults(handler=cmd_wait)

    verify = commands.add_parser(
        "verify", help="Check production, audio, RSS, and imported-byte gates"
    )
    verify.add_argument("episode_id")
    verify.add_argument("--source", help="Original audio file of an imported episode")
    verify.add_argument("--source-id", help="Expected import source ID")
    verify.add_argument("--episode-number", type=int, help="Expected episode number")
    verify.set_defaults(handler=cmd_verify)

    import_audio = commands.add_parser(
        "import", help="Preflight (--dry-run) or submit one audio import"
    )
    import_audio.add_argument("--series", required=True, help="Series slug")
    import_audio.add_argument("--file", required=True, help="MP3 or M4A AAC file")
    import_audio.add_argument("--title", required=True)
    import_audio.add_argument("--source-id", required=True)
    import_audio.add_argument("--description")
    import_audio.add_argument("--episode-number", type=int)
    import_audio.add_argument("--dry-run", action="store_true")
    import_audio.add_argument(
        "--expect-sha256", help="source.sha256 from the authorized dry run"
    )
    import_audio.add_argument(
        "--evidence-dir", help="Private directory (mode 0700) for request and response"
    )
    import_audio.add_argument("--upload-timeout-seconds", type=float, default=1800)
    import_audio.set_defaults(handler=cmd_import)

    reconcile = commands.add_parser(
        "reconcile", help="Find episodes from an unclear submission, or check a manifest"
    )
    reconcile.add_argument("--series", help="Series slug")
    reconcile.add_argument("--source-id")
    reconcile.add_argument("--file", help="Audio file; compares its SHA-256")
    reconcile.add_argument("--sha256")
    reconcile.add_argument("--title")
    reconcile.add_argument("--topic")
    reconcile.add_argument("--script-file")
    reconcile.add_argument("--manifest", help="Collection manifest JSON")
    reconcile.set_defaults(handler=cmd_reconcile)

    opml = commands.add_parser("opml-check", help="Check an OPML subscription export")
    opml.add_argument("--url", help="Download URL of the export")
    opml.add_argument("--file", help="Private backing OPML file")
    opml.add_argument("--expect-filename", help="Attachment filename; default: URL basename")
    opml.add_argument("--expect-slug", action="append", help="Series slug the file must list")
    opml.add_argument("--check-feeds", action="store_true", help="Fetch every outline feed")
    opml.add_argument(
        "--expect-episode", action="append", help="Episode ID that a listed feed must deliver"
    )
    opml.set_defaults(handler=cmd_opml_check)
    return root


def main() -> int:
    args = parser().parse_args()
    if args.request_timeout_seconds <= 0:
        raise ClientError("--request-timeout-seconds must be positive")
    if hasattr(args, "timeout_seconds") and args.timeout_seconds <= 0:
        raise ClientError("--timeout-seconds must be positive")
    if hasattr(args, "interval_seconds") and args.interval_seconds <= 0:
        raise ClientError("--interval-seconds must be positive")
    if hasattr(args, "upload_timeout_seconds") and args.upload_timeout_seconds <= 0:
        raise ClientError("--upload-timeout-seconds must be positive")
    client = PodcraftClient(args.base_url, args.request_timeout_seconds)
    return args.handler(client, args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ClientError as error:
        print(f"podcraft_api: {error}", file=sys.stderr)
        raise SystemExit(1)
