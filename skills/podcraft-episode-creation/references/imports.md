# Audio import contract

Use this branch for an existing recording. Podcraft validates the media, keeps
its bytes, and returns a ready episode with `sourceType=imported`. It does not
write a script, run TTS, or encode the audio. Generation and retry do not apply
to imported episodes.

## Resolve the source

Decide these values and record them before preflight:

- the existing series slug;
- the title, and an optional description and episode number;
- the absolute path of the audio file;
- a stable source ID, such as `publisher:asset-123`.

Make the source ID from the publisher's canonical asset ID. Do not put a signed
media URL in it. Keep the same source ID for each attempt on the same recording.

The file must be MP3 audio in an MP3 file or AAC audio in an M4A file. Cover art
is permitted. If the source is a video with AAC audio, make an audio-only copy
without a new encode:

```bash
ffmpeg -i "$VIDEO_FILE" -map 0:a:0 -vn -c:a copy \
  -movflags +faststart "$AUDIO_FILE"
```

## Preflight

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" import --dry-run \
  --series "$SERIES_SLUG" --file "$AUDIO_FILE" \
  --title "$TITLE" --source-id "$SOURCE_ID"
```

Add `--description` or `--episode-number` only for decided values. Use the same
values for the dry run and the submission. The dry run sends no upload.

It applies the server's rules on this host: filename, size, ffprobe format,
metadata limits, and `db` and `ffprobe` readiness. It also reads the series
episodes and predicts the server decision. Read these fields:

- `blockers`: each item stops the submission. Resolve it first.
- `prediction.decision`: `new`, `reuse` (an identical earlier import), or
  `conflict`. `prediction.reasons` gives the cause of a conflict.
- `source.sha256`, `source.bytes`, `source.duration`, `source.mimeType`: record
  them as the authorized source.
- `serverOnlyChecks`: record them as pending. The server does them only during
  the upload.

For a `conflict`, examine the existing episode in `prediction.existingEpisodeId`
and decide with the user. Do not change the source ID to go around a conflict.

## Submit

After authorization, submit once:

```bash
EVIDENCE_DIR="$(mktemp -d)"
python3 "$SKILL_DIR/scripts/podcraft_api.py" import \
  --series "$SERIES_SLUG" --file "$AUDIO_FILE" \
  --title "$TITLE" --source-id "$SOURCE_ID" \
  --expect-sha256 "$SOURCE_SHA256" --evidence-dir "$EVIDENCE_DIR"
```

`--expect-sha256` is the dry run's `source.sha256`. The command does the
preflight again and stops if the file or a blocker changed. It streams the file
as a multipart upload. It writes the plan, response headers, and response body
into the evidence directory, which must have mode 0700. Read `outcome`:

| `outcome` | Exit | Meaning and next action |
| --- | --- | --- |
| `created` | 0 | New episode. Continue with [verification.md](verification.md). |
| `reused` | 0 | Identical earlier import. Verify the returned ID. |
| `rejected` | 1 | `result.error` and `result.code` give the server cause. Resolve it with the user. |
| `notSubmitted` | 1 | No connection opened. You can run the same command again. |
| `unknown` | 4 | The response is lost. Run `reconcile` (below) before any new attempt. |

`episodeId` is the new or reused episode. RSS uses the Podcraft creation date. It
does not use the original publication date.

## Reconcile an unclear submission

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" reconcile \
  --series "$SERIES_SLUG" --source-id "$SOURCE_ID" --file "$AUDIO_FILE"
```

Read `outcome`. `one` gives the episode that matches all criteria. `none` means
no episode matches, so a second submission with the same values is safe.
`review` means partial matches: compare `matched` and `differs` for each
candidate, then decide.

## Local CLI on the server

Use this path only when the Podcraft checkout and its production environment
file are on this host. Read the CLI's `--help` for current options. It has its
own `--dry-run` with the server's full checks, including database conflicts:

```bash
cd /opt/stacks/podcast-creator
bun scripts/import-audio-episode.ts \
  --env-file /opt/stacks/podcast-creator/.env.production \
  --series "$SERIES_SLUG" --file "$AUDIO_FILE" \
  --title "$TITLE" --source-id "$SOURCE_ID" --dry-run
```

Give `--env-file` explicitly. It selects the local database and audio storage,
and it must contain `DATABASE_URL` and `EPISODES_DIR`. Keep its contents
private. The database must already have the import migration. `--base-url`
changes only the returned links. After authorization, remove `--dry-run` and run
once. Require exit code 0 and a nonempty result `id`.

## Collections

Keep a manifest file for a collection. Use one item for each released recording
and for each requested bonus item:

```json
{
  "series": "toylight",
  "items": [
    {"sourceId": "dropout:4192580", "title": "Episode 1", "file": "ep1.m4a",
     "episodeNumber": 1, "kind": "released"},
    {"sourceId": "dropout:4300001", "title": "Bonus", "sha256": "…", "kind": "bonus"}
  ]
}
```

Each item needs `sourceId` and `title`. An item can set its own `series`. A
relative `file` is relative to the manifest. Add `description` only when the
import used one. Then run:

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" reconcile --manifest "$MANIFEST"
```

Read `counts.total`. It gives `ready`, `mismatch`, `failed`, and `pending`
separately. `counts.byKind` splits them into released and bonus items. For each
`mismatch`, read `differences` and decide with the user to accept it or to
correct it. `unexpectedImports` lists imported episodes that the manifest does
not name. Exit code 0 means that all items are ready. A collection with one or
more pending items stays pending, also when each completed upload plays.
