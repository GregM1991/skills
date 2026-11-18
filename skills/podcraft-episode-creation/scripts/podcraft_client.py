"""HTTP and tRPC transport shared by the Podcraft skill commands."""

from __future__ import annotations

import hashlib
import http.client
import json
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

DEFAULT_BASE_URL = "http://gm-home-server.geep-clownfish.ts.net:5200"
CHUNK_BYTES = 1024 * 1024


class ClientError(RuntimeError):
    """A local validation, transport, HTTP, or tRPC failure."""


class TransportError(ClientError):
    """The request got no HTTP response.

    `maybe_sent` is false only when the connection was never opened, so the
    server cannot have received the request.
    """

    def __init__(self, message: str, *, maybe_sent: bool) -> None:
        super().__init__(message)
        self.maybe_sent = maybe_sent


@dataclass
class HttpResponse:
    status: int
    headers: dict[str, str]
    body: bytes = b""
    length: int = 0
    sha256: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


def compact_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def print_json(value: Any) -> None:
    json.dump(value, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def redact_url(url: str) -> str:
    """Hide credentials that a subscription gateway puts in a URL.

    The gateway prefixes `/api/...` with a capability path such as
    `/s/<token>`. Userinfo and query strings can also carry secrets.
    """
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"
    path = parts.path
    index = path.find("/api/")
    if index > 0:
        path = "/<redacted>" + path[index:]
    query = "<redacted>" if parts.query else ""
    return urllib.parse.urlunsplit((parts.scheme, host, path, query, ""))


def _never_opened(reason: Any) -> bool:
    return isinstance(reason, (ConnectionRefusedError, socket.gaierror))


class PodcraftClient:
    def __init__(self, base_url: str, timeout_seconds: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    def url(self, target: str) -> str:
        return target if "://" in target else f"{self.base_url}{target}"

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

    def fetch(
        self,
        target: str,
        *,
        method: str = "GET",
        headers: dict[str, str] | None = None,
        data: Any | None = None,
        max_bytes: int | None = None,
        digest: bool = False,
        timeout: float | None = None,
    ) -> HttpResponse:
        """Send one request and return the status and headers for any HTTP status.

        `target` is a path on the base URL or an absolute URL. With `digest`,
        the whole body streams through SHA-256 and is not kept. Otherwise at
        most `max_bytes` bytes are read.
        """
        url = self.url(target)
        shown = redact_url(url)
        request = urllib.request.Request(
            url, data=data, headers=headers or {}, method=method
        )
        try:
            response = urllib.request.urlopen(
                request, timeout=timeout or self.timeout_seconds
            )
        except urllib.error.HTTPError as error:
            response = error
        except urllib.error.URLError as error:
            raise TransportError(
                f"Cannot reach {shown}: {error.reason}",
                maybe_sent=not _never_opened(error.reason),
            ) from error
        except (OSError, http.client.HTTPException) as error:
            raise TransportError(
                f"{method} {shown} failed: {error}",
                maybe_sent=not _never_opened(error),
            ) from error
        try:
            with response:
                status = int(getattr(response, "status", None) or response.code)
                response_headers = {
                    key.lower(): value for key, value in response.headers.items()
                }
                if digest:
                    hasher = hashlib.sha256()
                    length = 0
                    for chunk in iter(lambda: response.read(CHUNK_BYTES), b""):
                        hasher.update(chunk)
                        length += len(chunk)
                    return HttpResponse(
                        status, response_headers, b"", length, hasher.hexdigest()
                    )
                body = response.read() if max_bytes is None else response.read(max_bytes)
                return HttpResponse(status, response_headers, body, len(body))
        except (OSError, http.client.HTTPException) as error:
            raise TransportError(
                f"{method} {shown} failed while reading: {error}", maybe_sent=True
            ) from error

    def raw_request(
        self,
        path: str,
        *,
        method: str = "GET",
        headers: dict[str, str] | None = None,
        max_bytes: int | None = None,
    ) -> tuple[bytes, int, dict[str, str]]:
        response = self.fetch(path, method=method, headers=headers, max_bytes=max_bytes)
        return response.body, response.status, response.headers

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

    def readiness(self) -> dict[str, Any]:
        """Read `/api/health?ready=true`, including a degraded HTTP 503 body."""
        response = self.fetch("/api/health?ready=true", headers={"Accept": "application/json"})
        try:
            result = json.loads(response.body) if response.body else None
        except json.JSONDecodeError as error:
            raise ClientError(
                f"Readiness returned HTTP {response.status} without JSON"
            ) from error
        if not isinstance(result, dict):
            raise ClientError(f"Readiness returned HTTP {response.status} without an object")
        result["httpStatus"] = response.status
        return result


def iter_series_episodes(client: PodcraftClient, series_id: str) -> Iterator[dict[str, Any]]:
    """Yield the full detail of every episode in a series (read-only)."""
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


def bounded(value: str, label: str, maximum: int) -> str:
    trimmed = value.strip()
    if not trimmed:
        raise ClientError(f"{label} is empty after trimming")
    if len(trimmed) > maximum:
        raise ClientError(f"{label} is {len(trimmed)} characters; maximum is {maximum}")
    return trimmed


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


def sha256_file(path: Path) -> tuple[int, str]:
    hasher = hashlib.sha256()
    size = 0
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(CHUNK_BYTES), b""):
                hasher.update(chunk)
                size += len(chunk)
    except OSError as error:
        raise ClientError(f"Cannot read {path}: {error}") from error
    return size, hasher.hexdigest()


def series_summary(series: dict[str, Any]) -> dict[str, Any]:
    return {key: series.get(key) for key in ("id", "slug", "title")}
