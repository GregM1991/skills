# Audio import contract

Use this branch for an existing recording. Podcraft validates the media, preserves
its bytes, and returns a ready episode with `sourceType=imported`. It does not
write a script, run TTS, or encode the audio. Imported episodes are excluded from
generation and retry.

## Resolve the source

Record the existing series, title, absolute audio path, byte count, and SHA-256.
Use a stable source ID for automated imports, such as `publisher:asset-123`.
Derive it from the publisher's canonical asset ID; keep signed media URLs out of
the source ID. Record optional description and episode number before submission.

The file must be a nonempty MP3 or M4A AAC file, at most 1 GiB. Its plain filename
must match the format. Inspect the actual codec and duration, then hash the bytes:

```bash
ffprobe -v error -protocol_whitelist file -format_whitelist mp3,mov \
  -show_entries format=format_name,duration:stream=codec_type,codec_name:stream_disposition=attached_pic \
  -of json "$AUDIO_FILE"
sha256sum -- "$AUDIO_FILE"
```

Require one audio stream: MP3 in an MP3 container, or AAC in an M4A container.
Cover art is allowed; moving video and other media streams are rejected. Prepare
an audio-only file before importing a video. For an AAC source, stream copy
preserves the audio without another encode:

```bash
ffmpeg -i "$VIDEO_FILE" -map 0:a:0 -vn -c:a copy \
  -movflags +faststart "$AUDIO_FILE"
```

Run the import readiness checks in [api.md](api.md). Choose one submission path.

## Local CLI on the server

Use this path when the Podcraft checkout and its production environment file are
available. Read the CLI's `--help` for current options. Run from the checkout:

```bash
cd /opt/stacks/podcast-creator
bun scripts/import-audio-episode.ts \
  --env-file /opt/stacks/podcast-creator/.env.production \
  --series "$SERIES_SLUG" \
  --file "$AUDIO_FILE" \
  --title "$TITLE" \
  --source-id "$SOURCE_ID" \
  --dry-run
```

Pass the production `--env-file` explicitly. It overrides inherited environment
values and selects the local database and managed audio storage. It must contain
`DATABASE_URL`, a SQLite file URL, and `EPISODES_DIR`. Keep its contents private.
The database must already exist with the import migration applied. Resolve schema
deployment through the app's migration workflow before importing.

Relative database and storage paths resolve from the checkout. The input audio
path resolves from the caller's working directory. `--base-url` changes returned
links only; it does not select a server or database.

The dry run copies the audio into temporary storage and validates the format,
series, numbering, and duplicate rules. It removes the copy and leaves no episode
or persisted failure state. After authorization, remove `--dry-run` and run once.
Add `--description` or `--episode-number` only for resolved values, using the same
values during preflight and submission. Stdout is one JSON result; diagnostics
go to stderr. Require exit code zero and a nonempty result `id`.

## Multipart API from another host

Set `PODCRAFT_API_BASE_URL` as described in [api.md](api.md). Resolve `SERIES_ID`
from `series`; the endpoint does not accept a series slug.

API preflight consists of the read-only readiness, series, source-format, size,
and hash checks above. The API has no dry-run endpoint. Database conflicts and
the server's media validation are checked during the authorized upload. Record
those as pending during preflight.

Create a private evidence directory. Submit once with curl, which streams the
file from disk and saves the response separately from its headers:

```bash
EVIDENCE_DIR="$(mktemp -d)"
chmod 700 "$EVIDENCE_DIR"
curl --silent --show-error --fail-with-body \
  --connect-timeout 10 --max-time 1800 \
  --dump-header "$EVIDENCE_DIR/import.headers" \
  --output "$EVIDENCE_DIR/import.json" \
  --form-string "seriesId=$SERIES_ID" \
  --form-string "title=$TITLE" \
  --form-string "sourceId=$SOURCE_ID" \
  --form "file=@$AUDIO_FILE" \
  "$PODCRAFT_API_BASE_URL/api/episodes/import"
```

Add `--form-string "description=$DESCRIPTION"` and
`--form-string "episodeNumber=$EPISODE_NUMBER"` only for resolved values. The
endpoint requires `file`, `seriesId`, and `title`; `sourceId` is optional in the
API but required by this workflow for automated imports. Use the server's
structured error response to resolve rejected metadata or media.

A new import returns HTTP 201. Reusing an identical source ID returns HTTP 200.
Require successful HTTP status, valid JSON, and a nonempty `id`. Confirm `ready`
and provenance through `status <id>`, then apply [verification.md](verification.md).

## Reconcile and repeat

Keep the source ID, series, trimmed title and description, audio bytes, and any
explicit episode number unchanged when repeating an import. The service returns
the original ID and number for an identical import. HTTP 409 means a conflict,
including changed metadata/audio, occupied numbering, or audio already imported
in that series under another source ID. Inspect the existing episode before
choosing another action. A lost response does not justify a new source ID.

Both paths return the import result fields. Useful fields include
`id`, `episodeNumber`, `duplicate`, `audioMimeType`, `audioSize`, and `audioDuration`.
Original publication dates are not imported; RSS uses Podcraft's creation date.

For a collection, keep a manifest of canonical source IDs, paths, metadata, and
hashes. Reconcile every released recording and requested bonus item against it.
Report ready, failed, and pending counts separately. A partial collection remains
pending even when every completed upload is playable.
