"""Unit tests for the Podcraft skill client. Run: python3 -m unittest discover -s scripts

Every test uses fakes for HTTP and ffprobe and a temporary directory. No test
reaches a Podcraft service.
"""

from __future__ import annotations

import contextlib
import copy
import hashlib
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))

from podcraft_api import cmd_health, parser  # noqa: E402
from podcraft_client import (  # noqa: E402
    ClientError,
    HttpResponse,
    PodcraftClient,
    TransportError,
    redact_url,
)
from podcraft_delivery import (  # noqa: E402
    cmd_opml_check,
    feed_item_problems,
    parse_feed,
    verify_episode,
)
from podcraft_imports import (  # noqa: E402
    MultipartBody,
    cmd_import,
    cmd_reconcile,
    import_metadata,
    predict_import,
)
from podcraft_media import classify_audio, inspect_source  # noqa: E402

BASE = "http://podcraft.test"
FEED_BASE = "http://feeds.test"
SERIES = {"id": "series-1", "slug": "toylight", "title": "Toylight", "voice": "af_heart"}
AUDIO = bytes(range(256)) * 40  # 10,240 bytes
AUDIO_SHA = hashlib.sha256(AUDIO).hexdigest()

Handler = Callable[[str, dict[str, str], Any], "HttpResponse | Exception"]


def m4a_probe(duration: float = 12.5, extra_streams: list | None = None):
    def probe(_path: Path) -> dict[str, Any]:
        return {
            "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": str(duration)},
            "streams": [{"codec_type": "audio", "codec_name": "aac"}, *(extra_streams or [])],
        }
    return probe


def audio_route(data: bytes, mime: str = "audio/mp4", accept_ranges: str = "bytes") -> Handler:
    """Serve bytes with the range rules of Podcraft's audio route."""
    size = len(data)

    def handle(method: str, headers: dict[str, str], _body: Any) -> HttpResponse:
        base = {"content-type": mime, "accept-ranges": accept_ranges, "content-length": str(size)}
        if method == "HEAD":
            return HttpResponse(200, base)
        header = headers.get("Range")
        if not header:
            return HttpResponse(200, base, data)
        spec = header.removeprefix("bytes=")
        if spec.startswith("-"):
            start, end = max(0, size - int(spec[1:])), size - 1
        else:
            first, _, last = spec.partition("-")
            start, end = int(first), min(int(last) if last else size - 1, size - 1)
        if start >= size or start > end:
            return HttpResponse(416, {"content-range": f"bytes */{size}"})
        return HttpResponse(206, {**base, "content-range": f"bytes {start}-{end}/{size}",
                                  "content-length": str(end - start + 1)}, data[start:end + 1])
    return handle


def static(status: int, body: bytes = b"", headers: dict[str, str] | None = None) -> Handler:
    return lambda _method, _headers, _body: HttpResponse(status, headers or {}, body)


class FakeClient(PodcraftClient):
    """Serves tRPC reads from memory and HTTP from route handlers. Mutations fail."""

    def __init__(self, episodes: list[dict[str, Any]] | None = None,
                 routes: dict[str, Handler] | None = None,
                 health: dict[str, Any] | None = None, health_status: int = 200) -> None:
        super().__init__(BASE, 5)
        self.episodes = {item["id"]: item for item in episodes or []}
        self.routes = dict(routes or {})
        self.requests: list[tuple[str, str, dict[str, str]]] = []
        if health is not None:
            self.routes[f"{BASE}/api/health?ready=true"] = static(
                health_status, json.dumps(health).encode())

    def trpc(self, procedure: str, payload: Any, *, mutation: bool = False) -> Any:
        if mutation:
            raise AssertionError(f"test attempted mutation {procedure}")
        if procedure == "series.list":
            return [SERIES, {"id": "series-2", "slug": "other", "title": "Other"}]
        if procedure == "episode.get":
            if payload["id"] not in self.episodes:
                raise ClientError("not found")
            return copy.deepcopy(self.episodes[payload["id"]])
        if procedure == "episode.list":
            matches = [{"id": key} for key, item in self.episodes.items()
                       if item.get("seriesId") == payload["seriesId"]]
            page = matches[payload["offset"]:payload["offset"] + payload["limit"]]
            return {"episodes": page, "total": len(matches)}
        raise AssertionError(f"unexpected procedure {procedure}")

    def fetch(self, target: str, *, method: str = "GET", headers: dict[str, str] | None = None,
              data: Any = None, max_bytes: int | None = None, digest: bool = False,
              timeout: float | None = None) -> HttpResponse:
        url = self.url(target)
        headers = headers or {}
        self.requests.append((method, url, headers))
        handler = self.routes.get(url)
        if handler is None:
            return HttpResponse(404, {}, b"not found", 9)
        response = handler(method, headers, data)
        if isinstance(response, Exception):
            raise response
        body = response.body
        if digest:
            return HttpResponse(response.status, response.headers, b"", len(body),
                                hashlib.sha256(body).hexdigest())
        if max_bytes is not None:
            body = body[:max_bytes]
        return HttpResponse(response.status, response.headers, body, len(body))


def run(handler: Callable, client: PodcraftClient, argv: list[str], **kwargs) -> tuple[int, Any]:
    args = parser().parse_args(argv)
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = handler(client, args, **kwargs)
    text = out.getvalue()
    return code, json.loads(text) if text.strip() else None


def episode_record(**overrides: Any) -> dict[str, Any]:
    record = {
        "id": "ep-3", "seriesId": "series-1", "series": {"slug": "toylight", "title": "Toylight"},
        "title": "Episode three", "description": "About three", "status": "ready",
        "episodeNumber": 3, "sourceType": "imported", "sourceId": "dropout:3",
        "audioSha256": AUDIO_SHA, "audioSize": len(AUDIO), "audioDuration": 12.5,
        "audioMimeType": "audio/mp4", "audioPath": "/srv/audio/ep-3.m4a", "script": None,
        "error": None, "failedStep": None,
    }
    record.update(overrides)
    return record


def feed_xml(items: list[dict[str, Any]]) -> bytes:
    rendered = "".join(
        f"""<item><title>{item['title']}</title><guid isPermaLink="false">{item['id']}</guid>
        <enclosure url="{FEED_BASE}/api/episodes/{item['id']}/audio" length="{item['audioSize']}"
         type="{item['audioMimeType']}" />
        <itunes:episode>{item['episodeNumber']}</itunes:episode></item>"""
        for item in items
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel><title>Toylight</title>{rendered}</channel></rss>""".encode()


def delivery_routes(episode: dict[str, Any], data: bytes = AUDIO) -> dict[str, Handler]:
    audio = audio_route(data, episode["audioMimeType"])
    return {
        f"{BASE}/episodes/{episode['id']}": static(200),
        f"{BASE}/api/episodes/{episode['id']}/audio": audio,
        f"{FEED_BASE}/api/episodes/{episode['id']}/audio": audio,
        f"{BASE}/api/feed/toylight": static(200, feed_xml([episode])),
    }


class TempDirTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.audio = self.root / "episode.m4a"
        self.audio.write_bytes(AUDIO)

    def tearDown(self) -> None:
        self._tmp.cleanup()


class MediaTests(TempDirTest):
    def test_m4a_with_cover_art_is_importable(self) -> None:
        cover = {"codec_type": "video", "codec_name": "mjpeg", "disposition": {"attached_pic": 1}}
        result = classify_audio("a.m4a", m4a_probe(extra_streams=[cover])(Path("a.m4a")))
        self.assertEqual((result["format"], result["mimeType"], result["coverArt"]),
                         ("m4a", "audio/mp4", True))

    def test_mp3_is_importable(self) -> None:
        probe = {"format": {"format_name": "mp3", "duration": "3"},
                 "streams": [{"codec_type": "audio", "codec_name": "mp3"}]}
        self.assertEqual(classify_audio("a.MP3", probe)["mimeType"], "audio/mpeg")

    def test_moving_video_and_extension_mismatch_are_rejected(self) -> None:
        video = {"codec_type": "video", "codec_name": "h264", "disposition": {"attached_pic": 0}}
        with self.assertRaisesRegex(ClientError, "audio-only"):
            classify_audio("a.m4a", m4a_probe(extra_streams=[video])(Path("a.m4a")))
        with self.assertRaisesRegex(ClientError, "not MP3-in-MP3"):
            classify_audio("a.mp3", m4a_probe()(Path("a.mp3")))

    def test_inspect_source_hashes_and_validates_names(self) -> None:
        source = inspect_source(str(self.audio), m4a_probe())
        self.assertEqual((source["bytes"], source["sha256"]), (len(AUDIO), AUDIO_SHA))
        quoted = self.root / 'bad"name.m4a'
        quoted.write_bytes(AUDIO)
        with self.assertRaisesRegex(ClientError, "plain name"):
            inspect_source(str(quoted), m4a_probe())
        empty = self.root / "empty.m4a"
        empty.write_bytes(b"")
        with self.assertRaisesRegex(ClientError, "empty"):
            inspect_source(str(empty), m4a_probe())


class MetadataAndPredictionTests(unittest.TestCase):
    def meta(self, **overrides: Any) -> dict[str, Any]:
        values = {"title": "Episode three", "source_id": "dropout:3",
                  "description": "About three", "episode_number": None}
        values.update(overrides)
        return import_metadata(**values)

    def test_metadata_rules_match_the_server(self) -> None:
        with self.assertRaisesRegex(ClientError, "Source ID"):
            self.meta(source_id="-bad")
        with self.assertRaisesRegex(ClientError, "Episode number"):
            self.meta(episode_number=0)
        with self.assertRaisesRegex(ClientError, "bytes"):
            self.meta(description="é" * 9000)
        self.assertIsNone(self.meta(description="  ")["description"])

    def test_new_import_takes_the_next_number(self) -> None:
        prediction = predict_import([episode_record(sourceId="x", audioSha256="other")],
                                    "series-1", self.meta(source_id="dropout:4"), AUDIO_SHA)
        self.assertEqual((prediction["decision"], prediction["episodeNumber"]), ("new", 4))

    def test_identical_repeat_is_reuse(self) -> None:
        prediction = predict_import([episode_record()], "series-1", self.meta(), AUDIO_SHA)
        self.assertEqual((prediction["decision"], prediction["existingEpisodeId"]), ("reuse", "ep-3"))

    def test_changed_metadata_or_occupied_number_is_conflict(self) -> None:
        changed = predict_import([episode_record()], "series-1", self.meta(title="New"), AUDIO_SHA)
        self.assertEqual(changed["decision"], "conflict")
        self.assertIn("title differs", changed["reasons"][0])
        same_audio = predict_import([episode_record()], "series-1",
                                    self.meta(source_id="dropout:other"), AUDIO_SHA)
        self.assertIn("audio already imported", same_audio["reasons"][0])
        number = predict_import([episode_record(audioSha256="x")], "series-1",
                                self.meta(source_id="n", episode_number=3), AUDIO_SHA)
        self.assertIn("episode number 3", number["reasons"][0])
        incomplete = predict_import([episode_record(status="failed")], "series-1",
                                    self.meta(), AUDIO_SHA)
        self.assertEqual(incomplete["decision"], "conflict")


class MultipartTests(TempDirTest):
    def test_body_matches_the_server_reader_layout(self) -> None:
        body = MultipartBody([("seriesId", "series-1"), ("title", "Ep")], self.audio, "audio/mp4")
        chunks = []
        while chunk := body.read(1000):
            chunks.append(chunk)
        raw = b"".join(chunks)
        boundary = body.boundary.encode()
        self.assertEqual(len(raw), body.length)
        self.assertTrue(raw.startswith(b"--" + boundary + b"\r\n"))
        self.assertTrue(raw.endswith(b"\r\n--" + boundary + b"--\r\n"))
        parts = raw.split(b"\r\n--" + boundary)
        self.assertIn(b'name="seriesId"\r\n\r\nseries-1', parts[0])
        header, _, payload = parts[2].partition(b"\r\n\r\n")
        self.assertIn(b'name="file"; filename="episode.m4a"', header)
        self.assertEqual(payload, AUDIO)
        self.assertEqual(body.file_hash.hexdigest(), AUDIO_SHA)
        self.assertRegex(body.content_type, r"^multipart/form-data; boundary=[a-z0-9-]+$")


HEALTHY = {"status": "degraded", "checks": {"db": {"ok": True}, "ffprobe": {"ok": True},
                                            "tts": {"ok": False}}}


class ImportCommandTests(TempDirTest):
    def argv(self, *extra: str) -> list[str]:
        return ["import", "--series", "toylight", "--file", str(self.audio), "--title", "Ep four",
                "--source-id", "dropout:4", *extra]

    def client(self, import_handler: Handler | None = None, **kwargs: Any) -> FakeClient:
        routes = {f"{BASE}/api/episodes/import": import_handler} if import_handler else {}
        kwargs.setdefault("health", HEALTHY)
        kwargs.setdefault("health_status", 503)
        return FakeClient([episode_record(audioSha256="older")], routes, **kwargs)

    def test_dry_run_accepts_degraded_tts_and_sends_nothing(self) -> None:
        client = self.client()
        code, plan = run(cmd_import, client, self.argv("--dry-run"), probe=m4a_probe())
        self.assertEqual(code, 0)
        self.assertEqual((plan["readiness"]["ok"], plan["prediction"]["decision"]), (True, "new"))
        self.assertEqual(plan["source"]["sha256"], AUDIO_SHA)
        self.assertFalse([r for r in client.requests if r[0] == "POST"])

    def test_dry_run_reports_blockers(self) -> None:
        unhealthy = {"status": "degraded", "checks": {"db": {"ok": False}, "ffprobe": {"ok": True}}}
        code, plan = run(cmd_import, self.client(health=unhealthy), self.argv("--dry-run"),
                         probe=m4a_probe())
        self.assertEqual(code, 1)
        self.assertIn("server readiness", plan["blockers"][0])

    def test_submit_requires_hash_and_evidence(self) -> None:
        with self.assertRaisesRegex(ClientError, "expect-sha256"):
            run(cmd_import, self.client(), self.argv(), probe=m4a_probe())
        with self.assertRaisesRegex(ClientError, "evidence-dir"):
            run(cmd_import, self.client(), self.argv("--expect-sha256", AUDIO_SHA),
                probe=m4a_probe())
        with self.assertRaisesRegex(ClientError, "blockers"), contextlib.redirect_stdout(io.StringIO()):
            run(cmd_import, self.client(), self.argv("--expect-sha256", "0" * 64,
                                                     "--evidence-dir", str(self.root / "ev")),
                probe=m4a_probe())

    def submit(self, handler: Handler) -> tuple[int, Any, Path]:
        evidence = self.root / "evidence"
        code, report = run(cmd_import, self.client(handler),
                           self.argv("--expect-sha256", AUDIO_SHA, "--evidence-dir", str(evidence)),
                           probe=m4a_probe())
        return code, report, evidence

    def test_created_import_keeps_private_evidence(self) -> None:
        seen = {}

        def accept(method: str, headers: dict[str, str], body: Any) -> HttpResponse:
            seen["raw"] = b"".join(iter(lambda: body.read(4096), b""))
            seen["length"] = headers["Content-Length"]
            return HttpResponse(201, {"content-type": "application/json"},
                                json.dumps({"id": "ep-4", "episodeNumber": 4, "duplicate": False}).encode())

        code, report, evidence = self.submit(accept)
        self.assertEqual((code, report["outcome"], report["episodeId"]), (0, "created", "ep-4"))
        self.assertEqual(int(seen["length"]), len(seen["raw"]))
        self.assertEqual(stat.S_IMODE(evidence.stat().st_mode), 0o700)
        self.assertEqual(json.loads((evidence / "import.json").read_bytes())["id"], "ep-4")
        self.assertTrue((evidence / "import.headers").read_text().startswith("HTTP 201"))
        self.assertNotIn("warning", report)

    def test_conflict_is_rejected_and_lost_response_is_unknown(self) -> None:
        conflict = static(409, json.dumps({"error": "Episode number already exists",
                                           "code": "IMPORT_CONFLICT"}).encode())
        code, report, _ = self.submit(conflict)
        self.assertEqual((code, report["outcome"]), (1, "rejected"))

        code, report, _ = self.submit(lambda *_: TransportError("timed out", maybe_sent=True))
        self.assertEqual((code, report["outcome"]), (4, "unknown"))

        code, report, _ = self.submit(lambda *_: TransportError("refused", maybe_sent=False))
        self.assertEqual((code, report["outcome"]), (1, "notSubmitted"))

    def test_permissive_evidence_dir_is_refused(self) -> None:
        evidence = self.root / "open"
        evidence.mkdir(mode=0o755)
        os.chmod(evidence, 0o755)
        with self.assertRaisesRegex(ClientError, "0700"):
            run(cmd_import, self.client(static(201)),
                self.argv("--expect-sha256", AUDIO_SHA, "--evidence-dir", str(evidence)),
                probe=m4a_probe())


class ReconcileTests(TempDirTest):
    def test_single_reconcile_outcomes(self) -> None:
        client = FakeClient([episode_record(), episode_record(id="ep-2", sourceId="dropout:2",
                                                              title="Episode two", audioSha256="b")])
        _, none = run(cmd_reconcile, client, ["reconcile", "--series", "toylight",
                                              "--source-id", "dropout:9"])
        self.assertEqual(none["outcome"], "none")
        _, one = run(cmd_reconcile, client, ["reconcile", "--series", "toylight",
                                             "--source-id", "dropout:3", "--file", str(self.audio)])
        self.assertEqual((one["outcome"], one["candidates"][0]["id"]), ("one", "ep-3"))
        _, review = run(cmd_reconcile, client, ["reconcile", "--series", "toylight",
                                                "--source-id", "dropout:3", "--title", "Episode two"])
        self.assertEqual(review["outcome"], "review")

    def test_manifest_counts_each_state(self) -> None:
        episodes = [
            episode_record(),
            episode_record(id="ep-2", sourceId="dropout:2", title="Two", audioSha256="b",
                           episodeNumber=2),
            episode_record(id="ep-1", sourceId="dropout:1", title="One", audioSha256="c",
                           episodeNumber=1, status="failed"),
            episode_record(id="ep-9", sourceId="dropout:9", title="Extra", audioSha256="d",
                           episodeNumber=9),
        ]
        manifest = {"series": "toylight", "items": [
            {"sourceId": "dropout:3", "title": "Episode three", "file": "episode.m4a",
             "description": "About three", "episodeNumber": 3},
            {"sourceId": "dropout:2", "title": "Two renamed", "sha256": "b"},
            {"sourceId": "dropout:1", "title": "One"},
            {"sourceId": "dropout:5", "title": "Bonus", "kind": "bonus"},
        ]}
        path = self.root / "manifest.json"
        path.write_text(json.dumps(manifest))
        code, report = run(cmd_reconcile, FakeClient(episodes),
                           ["reconcile", "--manifest", str(path)])
        self.assertEqual(code, 1)
        self.assertEqual(report["counts"]["total"],
                         {"ready": 1, "mismatch": 1, "failed": 1, "pending": 1})
        self.assertEqual(report["counts"]["byKind"]["bonus"]["pending"], 1)
        states = {item["sourceId"]: item["state"] for item in report["items"]}
        self.assertEqual(states["dropout:3"], "ready")
        self.assertEqual([item["sourceId"] for item in report["unexpectedImports"]], ["dropout:9"])

    def test_manifest_rejects_repeated_source_ids(self) -> None:
        path = self.root / "manifest.json"
        path.write_text(json.dumps({"series": "toylight", "items": [
            {"sourceId": "a", "title": "A"}, {"sourceId": "a", "title": "B"}]}))
        with self.assertRaisesRegex(ClientError, "repeats"):
            run(cmd_reconcile, FakeClient([]), ["reconcile", "--manifest", str(path)])


class VerifyTests(TempDirTest):
    def verify(self, episode: dict[str, Any], routes: dict[str, Handler], *extra: str):
        args = parser().parse_args(["verify", episode["id"], *extra])
        return verify_episode(FakeClient([episode], routes), args, m4a_probe())

    def test_generated_episode_passes_every_gate(self) -> None:
        episode = episode_record(sourceType="generated", sourceId=None, audioSha256=None,
                                 script="Hello", audioMimeType="audio/mpeg")
        result, passed = self.verify(episode, delivery_routes(episode))
        self.assertTrue(passed, result["failedGates"])
        self.assertNotIn("importProvenance", result["gates"])

    def test_import_with_source_passes_byte_gates(self) -> None:
        episode = episode_record()
        result, passed = self.verify(episode, delivery_routes(episode), "--source", str(self.audio),
                                     "--source-id", "dropout:3", "--episode-number", "3")
        self.assertTrue(passed, result["failedGates"])
        for gate in ("importSha256", "suffixRange", "outOfRange", "importDuration"):
            self.assertTrue(result["gates"][gate])

    def test_import_without_source_fails(self) -> None:
        episode = episode_record()
        result, passed = self.verify(episode, delivery_routes(episode))
        self.assertFalse(passed)
        self.assertEqual(result["failedGates"], ["importSource"])

    def test_detects_served_byte_and_header_defects(self) -> None:
        episode = episode_record()
        routes = delivery_routes(episode)
        corrupt = AUDIO[:-1] + b"\x00"
        routes[f"{BASE}/api/episodes/ep-3/audio"] = audio_route(corrupt, accept_ranges="none")
        result, passed = self.verify(episode, routes, "--source", str(self.audio))
        self.assertFalse(passed)
        for gate in ("importSha256", "suffixRange", "audioHead", "storedSha256"):
            self.assertIn(gate, result["failedGates"])

    def test_feed_item_mismatch_and_unreachable_enclosure(self) -> None:
        episode = episode_record()
        routes = delivery_routes(episode)
        routes[f"{BASE}/api/feed/toylight"] = static(200, feed_xml([{**episode, "audioSize": 1}]))
        routes[f"{FEED_BASE}/api/episodes/ep-3/audio"] = (
            lambda *_: TransportError("Cannot reach feeds.test", maybe_sent=False))
        result, _ = self.verify(episode, routes, "--source", str(self.audio))
        self.assertIn("feedItem", result["failedGates"])
        self.assertIn("enclosureRange", result["failedGates"])
        self.assertIn("enclosure length is 1", result["problems"]["feedItem"])

    def test_feed_parsing_requires_one_exact_guid(self) -> None:
        episode = episode_record()
        items = parse_feed(feed_xml([episode, {**episode, "id": "ep-30"}]))
        item, problems = feed_item_problems(items, episode)
        self.assertEqual((item["guid"], problems), ("ep-3", []))
        _, problems = feed_item_problems(parse_feed(feed_xml([episode, episode])), episode)
        self.assertIn("found 2 items", problems[0])


TOKEN_FEED = "https://gw.test:10000/s/SECRET-token_123/api/feed/{slug}"


def opml(slugs: list[str]) -> bytes:
    outlines = "".join(
        f'<outline type="rss" text="{slug}" title="{slug}" xmlUrl="{TOKEN_FEED.format(slug=slug)}"/>'
        for slug in slugs)
    return f'<?xml version="1.0"?><opml version="2.0"><body>{outlines}</body></opml>'.encode()


DOWNLOAD_HEADERS = {"content-type": "application/octet-stream",
                    "content-disposition": 'attachment; filename="d20.opml"',
                    "cache-control": "private, no-store"}


class OpmlTests(TempDirTest):
    def test_download_matches_file_and_hides_tokens(self) -> None:
        body = opml(["toylight", "cloudward-ho"])
        path = self.root / "d20.opml"
        path.write_bytes(body)
        episode = episode_record()
        client = FakeClient([episode], {
            "https://pod.test/private-exports/d20.opml?download=1": static(200, body, DOWNLOAD_HEADERS),
            TOKEN_FEED.format(slug="toylight"): static(200, feed_xml([episode])),
            TOKEN_FEED.format(slug="cloudward-ho"): static(200, feed_xml([])),
            f"{FEED_BASE}/api/episodes/ep-3/audio": audio_route(AUDIO),
        })
        code, report = run(cmd_opml_check, client, [
            "opml-check", "--url", "https://pod.test/private-exports/d20.opml?download=1",
            "--file", str(path), "--expect-slug", "toylight", "--expect-slug", "cloudward-ho",
            "--check-feeds", "--expect-episode", "ep-3"])
        self.assertEqual(code, 0, report["failedGates"])
        self.assertNotIn("SECRET", json.dumps(report))

    def test_inline_xml_page_and_unreachable_feed_fail(self) -> None:
        body = opml(["toylight"])
        client = FakeClient([], {
            "https://pod.test/d20.opml": static(200, body, {"content-type": "text/xml"}),
            TOKEN_FEED.format(slug="toylight"): (
                lambda *_: TransportError(f"Cannot reach {redact_url(TOKEN_FEED)}", maybe_sent=False)),
        })
        code, report = run(cmd_opml_check, client, [
            "opml-check", "--url", "https://pod.test/d20.opml", "--expect-slug", "ddia",
            "--check-feeds"])
        self.assertEqual(code, 1)
        for gate in ("attachment", "contentType", "cacheControl", "expectedFeeds", "feedsReachable"):
            self.assertIn(gate, report["failedGates"])
        self.assertNotIn("SECRET", json.dumps(report))


class ClientTests(unittest.TestCase):
    def test_redact_url(self) -> None:
        self.assertEqual(redact_url("https://u:p@gw.test:10000/s/tok/api/feed/x?k=v"),
                         "https://gw.test:10000/<redacted>/api/feed/x?<redacted>")
        self.assertEqual(redact_url("http://h:5200/api/feed"), "http://h:5200/api/feed")

    def test_health_require_passes_degraded_service(self) -> None:
        client = FakeClient(health=HEALTHY, health_status=503)
        code, result = run(cmd_health, client, ["health", "--require", "db", "--require", "ffprobe"])
        self.assertEqual((code, result["required"]["failed"]), (0, []))
        code, result = run(cmd_health, client, ["health", "--require", "tts"])
        self.assertEqual((code, result["required"]["failed"]), (1, ["tts"]))

    def test_existing_commands_still_parse(self) -> None:
        for argv in (["series"], ["series", "create", "--title", "T", "--slug", "t", "--dry-run"],
                     ["create", "byos", "--series", "s", "--title", "T", "--script-file", "f"],
                     ["create", "generated", "--series", "s", "--topic", "T", "--summary-file", "f"],
                     ["status", "id"], ["wait", "id"], ["verify", "id"], ["voices"]):
            self.assertTrue(callable(parser().parse_args(argv).handler))


if __name__ == "__main__":
    unittest.main()
