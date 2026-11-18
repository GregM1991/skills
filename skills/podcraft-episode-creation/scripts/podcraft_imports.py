"""Audio import preflight, submission, and reconciliation."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import uuid
from pathlib import Path
from typing import Any, Iterable

from podcraft_client import (
    ClientError,
    PodcraftClient,
    TransportError,
    bounded,
    iter_series_episodes,
    print_json,
    read_text,
    series_summary,
    sha256_file,
)
from podcraft_media import Probe, inspect_source, run_ffprobe

SOURCE_ID_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9:._-]*$")
MAX_FIELD_BYTES = 16 * 1024
MAX_EPISODE_NUMBER = 2_147_483_647
IMPORT_CHECKS = ("db", "ffprobe")
EXIT_UNKNOWN = 4
SERVER_ONLY_CHECKS = [
    "source ID reuse in another series",
    "server media validation of the uploaded bytes",
    "free audio storage on the server",
]


def field_text(value: str, label: str, maximum: int) -> str:
    text = bounded(value, label, maximum)
    if len(text.encode()) > MAX_FIELD_BYTES:
        raise ClientError(f"{label} exceeds {MAX_FIELD_BYTES} bytes")
    return text


def import_metadata(
    *,
    title: str,
    source_id: str,
    description: str | None = None,
    episode_number: int | None = None,
) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "title": field_text(title, "title", 200),
        "sourceId": field_text(source_id, "source ID", 200),
        "description": None,
        "episodeNumber": None,
    }
    if not SOURCE_ID_PATTERN.fullmatch(metadata["sourceId"]):
        raise ClientError(
            "Source ID must start with a letter or digit and use only letters, digits, "
            "and : . _ -"
        )
    if description is not None and description.strip():
        metadata["description"] = field_text(description, "description", 10_000)
    if episode_number is not None:
        if not 1 <= episode_number <= MAX_EPISODE_NUMBER:
            raise ClientError(f"Episode number must be 1 to {MAX_EPISODE_NUMBER}")
        metadata["episodeNumber"] = episode_number
    return metadata


def import_readiness(client: PodcraftClient) -> dict[str, Any]:
    health = client.readiness()
    checks = health.get("checks") if isinstance(health.get("checks"), dict) else {}
    required = {name: checks.get(name) for name in IMPORT_CHECKS}
    ok = all(isinstance(item, dict) and item.get("ok") is True for item in required.values())
    return {"ok": ok, "status": health.get("status"), "checks": required}


def import_differences(
    existing: dict[str, Any], series_id: str, metadata: dict[str, Any], sha256: str
) -> list[str]:
    """Fields that make the server reject a repeated source ID (assertSameImport)."""
    differences = []
    if existing.get("sourceType") != "imported":
        differences.append(f"sourceType is {existing.get('sourceType')}")
    if existing.get("seriesId") not in (None, series_id):
        differences.append("series differs")
    if existing.get("audioSha256") != sha256:
        differences.append("audio SHA-256 differs")
    if existing.get("title") != metadata["title"]:
        differences.append(f"title differs: {existing.get('title')!r}")
    if (existing.get("description") or "") != (metadata.get("description") or ""):
        differences.append("description differs")
    number = metadata.get("episodeNumber")
    if number is not None and existing.get("episodeNumber") != number:
        differences.append(f"episode number is {existing.get('episodeNumber')}")
    return differences


def predict_import(
    episodes: Iterable[dict[str, Any]],
    series_id: str,
    metadata: dict[str, Any],
    sha256: str,
) -> dict[str, Any]:
    """Predict the server decision from the series' current episodes."""
    existing = same_audio = same_number = None
    highest = 0
    for episode in episodes:
        number = episode.get("episodeNumber")
        if isinstance(number, int):
            highest = max(highest, number)
            if number == metadata.get("episodeNumber"):
                same_number = episode
        if episode.get("sourceId") == metadata["sourceId"]:
            existing = episode
        if episode.get("audioSha256") == sha256:
            same_audio = episode

    if existing is not None:
        reasons = import_differences(existing, series_id, metadata, sha256)
        if not reasons and existing.get("status") != "ready":
            reasons.append(f"existing import is {existing.get('status')}, not ready")
        return {
            "decision": "conflict" if reasons else "reuse",
            "existingEpisodeId": existing.get("id"),
            "episodeNumber": existing.get("episodeNumber"),
            "reasons": reasons,
        }

    reasons = []
    if same_audio is not None:
        reasons.append(
            f"audio already imported as episode {same_audio.get('id')} "
            f"with source ID {same_audio.get('sourceId')!r}"
        )
    number = metadata.get("episodeNumber") or highest + 1
    if same_number is not None:
        reasons.append(f"episode number {number} belongs to episode {same_number.get('id')}")
    return {
        "decision": "conflict" if reasons else "new",
        "existingEpisodeId": same_audio.get("id") if same_audio else None,
        "episodeNumber": number,
        "reasons": reasons,
    }


def build_import_plan(
    client: PodcraftClient, args: argparse.Namespace, probe: Probe = run_ffprobe
) -> dict[str, Any]:
    series = client.resolve_series(args.series)
    metadata = import_metadata(
        title=args.title,
        source_id=args.source_id,
        description=args.description,
        episode_number=args.episode_number,
    )
    source = inspect_source(args.file, probe)
    readiness = import_readiness(client)
    prediction = predict_import(
        iter_series_episodes(client, series["id"]), series["id"], metadata, source["sha256"]
    )
    blockers = []
    if not readiness["ok"]:
        blockers.append("server readiness: db and ffprobe checks must be ok")
    if prediction["decision"] == "conflict":
        blockers.extend(prediction["reasons"])
    expected = getattr(args, "expect_sha256", None)
    if expected and expected.lower() != source["sha256"]:
        blockers.append("source SHA-256 differs from --expect-sha256")
    return {
        "branch": "import",
        "series": series_summary(series),
        "metadata": metadata,
        "source": source,
        "readiness": readiness,
        "prediction": prediction,
        "serverOnlyChecks": SERVER_ONLY_CHECKS,
        "blockers": blockers,
    }


class MultipartBody:
    """A streaming multipart/form-data body in the layout Podcraft's reader accepts."""

    def __init__(self, fields: list[tuple[str, str]], path: Path, mime_type: str) -> None:
        self.boundary = f"podcraft-{uuid.uuid4().hex}"
        head = b""
        for name, value in fields:
            head += (
                f'--{self.boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'
            ).encode() + value.encode() + b"\r\n"
        head += (
            f'--{self.boundary}\r\nContent-Disposition: form-data; name="file"; '
            f'filename="{path.name}"\r\nContent-Type: {mime_type}\r\n\r\n'
        ).encode()
        self._parts = [head, None, f"\r\n--{self.boundary}--\r\n".encode()]
        self._path = path
        self._file_size = path.stat().st_size
        self.length = len(head) + self._file_size + len(self._parts[2])
        self.file_hash = hashlib.sha256()
        self._index = 0
        self._offset = 0
        self._handle = None

    @property
    def content_type(self) -> str:
        return f"multipart/form-data; boundary={self.boundary}"

    def read(self, size: int = -1) -> bytes:
        if size is None or size < 0:
            size = 1024 * 1024
        while self._index < len(self._parts):
            part = self._parts[self._index]
            if part is None:
                if self._handle is None:
                    self._handle = self._path.open("rb")
                chunk = self._handle.read(size)
                if chunk:
                    self.file_hash.update(chunk)
                    return chunk
                self._handle.close()
            else:
                chunk = part[self._offset:self._offset + size]
                if chunk:
                    self._offset += len(chunk)
                    return chunk
            self._index += 1
            self._offset = 0
        return b""

    def close(self) -> None:
        if self._handle is not None:
            self._handle.close()


def prepare_evidence_dir(path_text: str) -> Path:
    path = Path(path_text).expanduser().resolve()
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.stat().st_mode & 0o077:
        raise ClientError(f"Evidence directory {path} must have mode 0700")
    return path


def write_private(path: Path, data: bytes) -> None:
    path.touch(mode=0o600, exist_ok=True)
    path.write_bytes(data)


def submit_import(
    client: PodcraftClient, plan: dict[str, Any], evidence: Path, timeout: float
) -> tuple[dict[str, Any], int]:
    metadata = plan["metadata"]
    fields = [("seriesId", plan["series"]["id"]), ("title", metadata["title"]),
              ("sourceId", metadata["sourceId"])]
    if metadata.get("description"):
        fields.append(("description", metadata["description"]))
    if metadata.get("episodeNumber") is not None:
        fields.append(("episodeNumber", str(metadata["episodeNumber"])))
    body = MultipartBody(fields, Path(plan["source"]["path"]), plan["source"]["mimeType"])
    write_private(evidence / "import.plan.json", json.dumps(plan, indent=2).encode())
    report: dict[str, Any] = {"evidenceDir": str(evidence), "plan": plan}
    try:
        response = client.fetch(
            "/api/episodes/import",
            method="POST",
            headers={
                "Accept": "application/json",
                "Content-Type": body.content_type,
                "Content-Length": str(body.length),
            },
            data=body,
            max_bytes=1024 * 1024,
            timeout=timeout,
        )
    except TransportError as error:
        report["error"] = str(error)
        report["outcome"] = "unknown" if error.maybe_sent else "notSubmitted"
        write_private(evidence / "import.error.txt", str(error).encode())
        return report, EXIT_UNKNOWN if error.maybe_sent else 1
    finally:
        body.close()

    headers = "".join(f"{key}: {value}\n" for key, value in response.headers.items())
    write_private(evidence / "import.headers", f"HTTP {response.status}\n{headers}".encode())
    write_private(evidence / "import.json", response.body)
    report["httpStatus"] = response.status
    if body.file_hash.hexdigest() != plan["source"]["sha256"]:
        report["warning"] = "source bytes changed during upload"
    try:
        result = json.loads(response.body) if response.body else None
    except json.JSONDecodeError:
        result = None
    report["result"] = result
    if response.status in (200, 201) and isinstance(result, dict) and result.get("id"):
        report["outcome"] = "created" if response.status == 201 else "reused"
        report["episodeId"] = result["id"]
        return report, 0
    if response.status >= 400 and isinstance(result, dict) and result.get("error"):
        report["outcome"] = "rejected"
        return report, 1
    report["outcome"] = "unknown"
    return report, EXIT_UNKNOWN


def cmd_import(
    client: PodcraftClient, args: argparse.Namespace, probe: Probe = run_ffprobe
) -> int:
    plan = build_import_plan(client, args, probe)
    if args.dry_run:
        print_json(plan)
        return 1 if plan["blockers"] else 0
    if not args.expect_sha256:
        raise ClientError("Submission requires --expect-sha256 with the dry run's source.sha256")
    if not args.evidence_dir:
        raise ClientError("Submission requires --evidence-dir for private import evidence")
    if plan["blockers"]:
        print_json(plan)
        raise ClientError("Preflight has blockers; nothing was submitted")
    evidence = prepare_evidence_dir(args.evidence_dir)
    report, code = submit_import(client, plan, evidence, args.upload_timeout_seconds)
    print_json(report)
    return code


# Reconciliation -------------------------------------------------------------


def episode_brief(episode: dict[str, Any]) -> dict[str, Any]:
    return {
        key: episode.get(key)
        for key in ("id", "title", "status", "sourceType", "sourceId", "episodeNumber",
                    "audioSha256", "createdAt")
    }


def cmd_reconcile(client: PodcraftClient, args: argparse.Namespace) -> int:
    if args.manifest:
        report = reconcile_manifest(client, Path(args.manifest))
        print_json(report)
        return 0 if report["complete"] else 1
    if not args.series:
        raise ClientError("reconcile needs --series, or --manifest")
    criteria: dict[str, str] = {}
    if args.source_id:
        criteria["sourceId"] = args.source_id.strip()
    if args.file:
        criteria["audioSha256"] = sha256_file(Path(args.file).expanduser().resolve())[1]
    elif args.sha256:
        criteria["audioSha256"] = args.sha256.lower()
    if args.title:
        criteria["title"] = args.title.strip()
    if args.topic:
        criteria["topic"] = args.topic.strip()
    if args.script_file:
        criteria["script"] = read_text(args.script_file, "script", 200_000)[1]
    if not criteria:
        raise ClientError(
            "Give at least one of --source-id, --file, --sha256, --title, --topic, --script-file"
        )
    series = client.resolve_series(args.series)
    candidates = []
    for episode in iter_series_episodes(client, series["id"]):
        matched = [key for key, value in criteria.items()
                   if str(episode.get(key) or "").strip() == value]
        if matched:
            candidates.append({
                **episode_brief(episode),
                "matched": matched,
                "differs": [key for key in criteria if key not in matched],
            })
    candidates.sort(key=lambda item: -len(item["matched"]))
    exact = [item for item in candidates if not item["differs"]]
    outcome = "none" if not candidates else "one" if len(exact) == 1 and len(candidates) == 1 else "review"
    print_json({
        "series": series_summary(series),
        "criteria": {key: (value if key != "script" else f"{len(value)} characters")
                     for key, value in criteria.items()},
        "outcome": outcome,
        "candidates": candidates,
    })
    return 0


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ClientError(f"Cannot read manifest {path}: {error}") from error
    items = manifest.get("items") if isinstance(manifest, dict) else None
    if not isinstance(items, list) or not items:
        raise ClientError("Manifest needs a nonempty items list")
    seen = set()
    for index, item in enumerate(items):
        if not isinstance(item, dict) or not item.get("sourceId") or not item.get("title"):
            raise ClientError(f"Manifest item {index} needs sourceId and title")
        if not (item.get("series") or manifest.get("series")):
            raise ClientError(f"Manifest item {index} has no series")
        if item["sourceId"] in seen:
            raise ClientError(f"Manifest repeats source ID {item['sourceId']}")
        seen.add(item["sourceId"])
    return manifest


def manifest_item_sha256(item: dict[str, Any], base: Path) -> tuple[str | None, list[str]]:
    issues = []
    expected = item.get("sha256")
    if item.get("file"):
        path = (base / item["file"]).expanduser().resolve()
        if path.is_file():
            actual = sha256_file(path)[1]
            if expected and expected.lower() != actual:
                issues.append("manifest sha256 differs from the file")
            return actual, issues
        issues.append(f"source file missing: {path}")
    return (expected.lower() if expected else None), issues


def reconcile_manifest(client: PodcraftClient, path: Path) -> dict[str, Any]:
    manifest = load_manifest(path)
    base = path.expanduser().resolve().parent
    slugs = sorted({item.get("series") or manifest["series"] for item in manifest["items"]})
    by_source: dict[str, dict[str, Any]] = {}
    imported_by_series: dict[str, list[dict[str, Any]]] = {}
    series_ids = {}
    for slug in slugs:
        series = client.resolve_series(slug)
        series_ids[slug] = series["id"]
        imported_by_series[slug] = []
        for episode in iter_series_episodes(client, series["id"]):
            if episode.get("sourceId"):
                by_source[episode["sourceId"]] = episode
            if episode.get("sourceType") == "imported":
                imported_by_series[slug].append(episode)

    results = []
    for item in manifest["items"]:
        slug = item.get("series") or manifest["series"]
        kind = item.get("kind", "released")
        sha256, issues = manifest_item_sha256(item, base)
        episode = by_source.get(item["sourceId"])
        entry: dict[str, Any] = {"sourceId": item["sourceId"], "kind": kind, "series": slug,
                                 "title": item["title"]}
        if episode is None:
            entry["state"] = "pending"
        else:
            entry["episode"] = episode_brief(episode)
            metadata = {
                "title": str(item["title"]).strip(),
                "description": (item.get("description") or "").strip() or None,
                "episodeNumber": item.get("episodeNumber"),
            }
            differences = import_differences(episode, series_ids[slug], metadata, sha256 or "")
            if sha256 is None:
                differences = [d for d in differences if d != "audio SHA-256 differs"]
                issues.append("no file or sha256 in manifest; audio not compared")
            if "description" not in item:
                differences = [d for d in differences if d != "description differs"]
            entry["differences"] = differences
            if episode.get("status") != "ready":
                entry["state"] = "failed"
            else:
                entry["state"] = "mismatch" if differences else "ready"
        if issues:
            entry["issues"] = issues
        results.append(entry)

    known = {item["sourceId"] for item in manifest["items"]}
    unexpected = [episode_brief(ep) for eps in imported_by_series.values() for ep in eps
                  if ep.get("sourceId") not in known]
    counts: dict[str, dict[str, int]] = {}
    for entry in results:
        bucket = counts.setdefault(entry["kind"], {"ready": 0, "mismatch": 0, "failed": 0, "pending": 0})
        bucket[entry["state"]] += 1
    total = {state: sum(bucket[state] for bucket in counts.values())
             for state in ("ready", "mismatch", "failed", "pending")}
    return {
        "manifest": str(path),
        "complete": total["ready"] == len(results),
        "counts": {"total": total, "byKind": counts},
        "items": results,
        "unexpectedImports": unexpected,
    }
