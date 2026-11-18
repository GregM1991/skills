"""Local audio checks that mirror Podcraft's import validation."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any, Callable

from podcraft_client import ClientError, sha256_file

MAX_AUDIO_BYTES = 1024 * 1024 * 1024
FILENAME_PATTERN = re.compile(r"^[^/\\\x00-\x1f\"]+\.(mp3|m4a)$", re.IGNORECASE)
# The same probe the server runs in app/server/services/audio-import/probe.ts.
FFPROBE_ARGS = [
    "ffprobe", "-v", "error", "-protocol_whitelist", "file",
    "-format_whitelist", "mp3,mov",
    "-show_entries",
    "format=format_name,duration:stream=codec_type,codec_name:stream_disposition=attached_pic",
    "-of", "json", "-i",
]

Probe = Callable[[Path], dict[str, Any]]


def run_ffprobe(path: Path) -> dict[str, Any]:
    try:
        result = subprocess.run(
            [*FFPROBE_ARGS, str(path)],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except FileNotFoundError as error:
        raise ClientError("ffprobe is not installed on this host") from error
    except subprocess.TimeoutExpired as error:
        raise ClientError(f"ffprobe timed out on {path}") from error
    if result.returncode != 0:
        raise ClientError(
            f"ffprobe rejected {path}: {result.stderr.strip() or result.returncode}"
        )
    try:
        parsed = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ClientError(f"ffprobe returned non-JSON output for {path}") from error
    if not isinstance(parsed, dict):
        raise ClientError(f"ffprobe returned a non-object result for {path}")
    return parsed


def classify_audio(filename: str, probe: dict[str, Any]) -> dict[str, Any]:
    """Apply the server's format rules to one ffprobe result."""
    problems: list[str] = []
    fmt = probe.get("format") if isinstance(probe.get("format"), dict) else {}
    format_name = str(fmt.get("format_name", ""))
    try:
        duration = float(fmt.get("duration"))
    except (TypeError, ValueError):
        duration = 0.0
    if not duration > 0:
        problems.append("duration is missing or not positive")
    streams = [item for item in probe.get("streams") or [] if isinstance(item, dict)]
    audio = [item for item in streams if item.get("codec_type") == "audio"]
    if len(audio) != 1:
        problems.append(f"expected one audio stream, found {len(audio)}")
    for item in streams:
        if item.get("codec_type") == "audio":
            continue
        cover = item.get("codec_type") == "video" and (
            (item.get("disposition") or {}).get("attached_pic") == 1
        )
        if not cover:
            problems.append(
                f"unsupported {item.get('codec_type')} stream ({item.get('codec_name')}); "
                "prepare an audio-only file"
            )
    codec = audio[0].get("codec_name") if len(audio) == 1 else None
    extension = Path(filename).suffix.lower()
    kind = None
    if extension == ".mp3" and format_name == "mp3" and codec == "mp3":
        kind = ("mp3", "audio/mpeg")
    elif extension == ".m4a" and "m4a" in format_name.split(",") and codec == "aac":
        kind = ("m4a", "audio/mp4")
    elif not problems:
        problems.append(
            f"{extension or 'no extension'} with container {format_name} and codec {codec} "
            "is not MP3-in-MP3 or AAC-in-M4A"
        )
    if problems or kind is None:
        raise ClientError(f"{filename} is not importable: " + "; ".join(problems))
    return {
        "format": kind[0],
        "mimeType": kind[1],
        "codec": codec,
        "container": format_name,
        "duration": duration,
        "coverArt": any(item.get("codec_type") == "video" for item in streams),
    }


def inspect_source(path_text: str, probe: Probe = run_ffprobe) -> dict[str, Any]:
    """Return the size, SHA-256, and media facts the import needs."""
    path = Path(path_text).expanduser().resolve()
    if not path.is_file():
        raise ClientError(f"Audio file not found: {path}")
    if not FILENAME_PATTERN.fullmatch(path.name) or len(path.name) > 255:
        raise ClientError(
            f'Filename "{path.name}" must be a plain name ending in .mp3 or .m4a, '
            "without quotes or control characters"
        )
    size = path.stat().st_size
    if size == 0:
        raise ClientError(f"Audio file is empty: {path}")
    if size > MAX_AUDIO_BYTES:
        raise ClientError(f"Audio file is {size} bytes; maximum is {MAX_AUDIO_BYTES}")
    media = classify_audio(path.name, probe(path))
    hashed_size, sha256 = sha256_file(path)
    if hashed_size != size:
        raise ClientError(f"{path} changed while it was read")
    return {"path": str(path), "filename": path.name, "bytes": size, "sha256": sha256, **media}
