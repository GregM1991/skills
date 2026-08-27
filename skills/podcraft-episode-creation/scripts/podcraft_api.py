#!/usr/bin/env python3
"""Small, dependency-free client for the Podcraft service."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_BASE_URL = "http://gm-home-server.geep-clownfish.ts.net:5200"
ACTIVE_STATUSES = {"pending", "generating_script", "generating_audio", "processing"}
TERMINAL_STATUSES = {"ready", "failed"}


class ClientError(RuntimeError):
    """A local validation, transport, HTTP, or tRPC failure."""


def compact_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def print_json(value: Any) -> None:
    json.dump(value, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


class PodcraftClient:
    def __init__(self, base_url: str, timeout_seconds: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    def request(
        self,
        path: str,
        *,
        method: str = "GET",
        body: Any | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[Any, int, dict[str, str]]:
        data = compact_json(body) if body is not None else None
        request_headers = {
            "Accept": "application/json",
            "X-TRPC-Source": "podcraft-episode-creation-skill",
            **(headers or {}),
        }
        if data is not None:
            request_headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            headers=request_headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(
                request, timeout=self.timeout_seconds
            ) as response:
                raw = response.read()
                response_headers = {
                    key.lower(): value for key, value in response.headers.items()
                }
                parsed = json.loads(raw) if raw else None
                return parsed, response.status, response_headers
        except urllib.error.HTTPError as error:
            raw = error.read()
            try:
                parsed = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                parsed = raw.decode(errors="replace")
            raise ClientError(
                f"HTTP {error.code} from {method} {path}: {json.dumps(parsed, ensure_ascii=False)}"
            ) from error
        except urllib.error.URLError as error:
            raise ClientError(
                f"Cannot reach {self.base_url}: {error.reason}"
            ) from error
        except json.JSONDecodeError as error:
            raise ClientError(f"Non-JSON response from {method} {path}") from error

    def raw_request(
        self,
        path: str,
        *,
        method: str = "GET",
        headers: dict[str, str] | None = None,
        max_bytes: int | None = None,
    ) -> tuple[bytes, int, dict[str, str]]:
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            headers=headers or {},
            method=method,
        )
        try:
            with urllib.request.urlopen(
                request, timeout=self.timeout_seconds
            ) as response:
                return (
                    response.read() if max_bytes is None else response.read(max_bytes),
                    response.status,
                    {key.lower(): value for key, value in response.headers.items()},
                )
        except urllib.error.HTTPError as error:
            return (
                error.read() if max_bytes is None else error.read(max_bytes),
                error.code,
                {key.lower(): value for key, value in error.headers.items()},
            )
        except urllib.error.URLError as error:
            raise ClientError(
                f"Cannot reach {self.base_url}: {error.reason}"
            ) from error

    def trpc(self, procedure: str, payload: Any, *, mutation: bool = False) -> Any:
        path = f"/api/trpc/{urllib.parse.quote(procedure)}"
        envelope = {"json": payload}
        if mutation:
            try:
                response, _, _ = self.request(path, method="POST", body=envelope)
            except ClientError as error:
                raise ClientError(
                    f"Create request did not return a usable result. Do not retry blindly. {error}"
                ) from error
        else:
            query = urllib.parse.urlencode(
                {
                    "input": json.dumps(
                        envelope, ensure_ascii=False, separators=(",", ":")
                    )
                }
            )
            response, _, _ = self.request(f"{path}?{query}")

        if not isinstance(response, dict):
            raise ClientError(f"Malformed tRPC response for {procedure}")
        error = response.get("error")
        if error is not None:
            details = error.get("json", error) if isinstance(error, dict) else error
            rendered = json.dumps(details, ensure_ascii=False)
            raise ClientError(f"Podcraft {procedure} failed: {rendered}")
        try:
            return response["result"]["data"]["json"]
        except (KeyError, TypeError) as error:
            raise ClientError(f"Malformed tRPC result for {procedure}") from error

    def series(self) -> list[dict[str, Any]]:
        result = self.trpc("series.list", None)
        if not isinstance(result, list):
            raise ClientError("series.list returned a non-list result")
        return result

    def resolve_series(self, slug: str) -> dict[str, Any]:
        series = self.series()
        match = next((item for item in series if item.get("slug") == slug), None)
        if match is None:
            available = ", ".join(sorted(str(item.get("slug")) for item in series))
            raise ClientError(
                f'Series "{slug}" not found. Available slugs: {available}'
            )
        return match

    def episode(self, episode_id: str) -> dict[str, Any]:
        result = self.trpc("episode.get", {"id": episode_id})
        if not isinstance(result, dict):
            raise ClientError("episode.get returned a non-object result")
        return result


def read_text(path_text: str, label: str, maximum: int) -> tuple[Path, str]:
    path = Path(path_text).expanduser().resolve()
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise ClientError(f"Cannot read {label} file {path}: {error}") from error
    if not text:
        raise ClientError(f"{label} file is empty after trimming: {path}")
    if len(text) > maximum:
        raise ClientError(f"{label} is {len(text)} characters; maximum is {maximum}")
    return path, text


def bounded(value: str, label: str, maximum: int) -> str:
    trimmed = value.strip()
    if not trimmed:
        raise ClientError(f"{label} is empty after trimming")
    if len(trimmed) > maximum:
        raise ClientError(f"{label} is {len(trimmed)} characters; maximum is {maximum}")
    return trimmed


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


def iter_series_episodes(client: PodcraftClient, series_id: str):
    offset = 0
    while True:
        page = client.trpc(
            "episode.list", {"limit": 100, "offset": offset, "seriesId": series_id}
        )
        if not isinstance(page, dict):
            raise ClientError("episode.list returned a non-object result")
        episodes = page.get("episodes", [])
        if not isinstance(episodes, list):
            raise ClientError("episode.list returned a non-list episodes field")
        for episode in episodes:
            yield client.episode(episode["id"])
        offset += len(episodes)
        if not episodes or offset >= int(page.get("total", 0)):
            return


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


def cmd_verify(client: PodcraftClient, args: argparse.Namespace) -> int:
    episode = client.episode(args.episode_id)
    series = episode.get("series") or {}
    slug = series.get("slug")
    if not slug:
        raise ClientError("episode.get returned no series slug")

    episode_url = f"{client.base_url}/episodes/{urllib.parse.quote(args.episode_id)}"
    audio_path = f"/api/episodes/{urllib.parse.quote(args.episode_id)}/audio"
    audio_url = f"{client.base_url}{audio_path}"
    feed_path = f"/api/feed/{urllib.parse.quote(str(slug))}"
    feed_url = f"{client.base_url}{feed_path}"

    _, page_status, _ = client.raw_request(
        f"/episodes/{urllib.parse.quote(args.episode_id)}", method="HEAD"
    )
    _, audio_status, audio_headers = client.raw_request(
        audio_path, headers={"Range": "bytes=0-0"}, max_bytes=1024
    )
    feed_body, feed_status, _ = client.raw_request(feed_path)
    feed_text = feed_body.decode(errors="replace")

    gates = {
        "production": (
            episode.get("status") == "ready"
            and bool(episode.get("id"))
            and isinstance(episode.get("audioDuration"), (int, float))
            and episode["audioDuration"] > 0
            and not episode.get("error")
        ),
        "episodePage": page_status == 200,
        "audioRange": audio_status == 206 and bool(audio_headers.get("content-range")),
        "seriesFeed": feed_status == 200
        and (args.episode_id in feed_text or audio_url in feed_text),
    }
    result = {
        "episodeId": args.episode_id,
        "status": episode.get("status"),
        "duration": episode.get("audioDuration"),
        "error": episode.get("error"),
        "failedStep": episode.get("failedStep"),
        "urls": {"episode": episode_url, "audio": audio_url, "feed": feed_url},
        "gates": gates,
        "audioResponse": {
            "status": audio_status,
            "contentRange": audio_headers.get("content-range"),
        },
    }
    print_json(result)
    return 0 if all(gates.values()) else 1


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
    health.set_defaults(handler=cmd_health)

    series = commands.add_parser("series", help="List existing series")
    series.set_defaults(handler=cmd_series)

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

    verify = commands.add_parser("verify", help="Check production and delivery gates")
    verify.add_argument("episode_id")
    verify.set_defaults(handler=cmd_verify)
    return root


def main() -> int:
    args = parser().parse_args()
    if args.request_timeout_seconds <= 0:
        raise ClientError("--request-timeout-seconds must be positive")
    if hasattr(args, "timeout_seconds") and args.timeout_seconds <= 0:
        raise ClientError("--timeout-seconds must be positive")
    if hasattr(args, "interval_seconds") and args.interval_seconds <= 0:
        raise ClientError("--interval-seconds must be positive")
    client = PodcraftClient(args.base_url, args.request_timeout_seconds)
    return args.handler(client, args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ClientError as error:
        print(f"podcraft_api: {error}", file=sys.stderr)
        raise SystemExit(1)
