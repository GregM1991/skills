# Episode verification contract

Readiness, delivery, and listening quality are separate gates.

## Wait for generation

Generated and BYOS submissions need a wait. Imports are ready on return; go to
the next section.

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" wait "$EPISODE_ID"
```

The command polls until `ready` or `failed`. It writes status changes to stderr
and the final episode JSON to stdout. It never starts or retries generation.
Exit 2 means `failed`: keep `error` and `failedStep` as evidence. Exit 3 means
the time limit stopped the wait. Increase `--timeout-seconds` (default 3600)
only when the expected episode length needs it.

## Verify delivery

For Generated and BYOS:

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" verify "$EPISODE_ID"
```

For an import, give the original file and the authorized values:

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" verify "$EPISODE_ID" \
  --source "$AUDIO_FILE" --source-id "$SOURCE_ID" --episode-number "$EPISODE_NUMBER"
```

The command downloads the full audio once and streams it through SHA-256. Exit
code 0 means that all gates passed. Read `failedGates` and `problems` for each
failure. The gates are:

| Gate | Check |
| --- | --- |
| `production` | Status `ready`, positive duration and size, an audio path, no `error`. |
| `episodePage` | The episode page returns HTTP 200. |
| `audioHead`, `audioGet` | HTTP 200, `Content-Length` equals `audioSize`, `Accept-Ranges: bytes`. |
| `audioRange` | `bytes=0-0` returns HTTP 206, one byte, `Content-Range: bytes 0-0/<size>`. |
| `seriesFeed`, `feedItem` | The series RSS has one item with the exact GUID, with the episode number, enclosure length, MIME type, and audio URL. |
| `enclosureRange` | The RSS enclosure URL (the server's `FEED_BASE_URL`) returns the first byte. |
| `storedSha256` | When stored, `audioSha256` equals the served audio. |
| `episodeNumber` | Equals `--episode-number`, when given. |

An imported episode also gets these gates. Without `--source`, `importSource`
fails:

| Gate | Check |
| --- | --- |
| `importProvenance` | `sourceType=imported`, empty script, and `--source-id` when given. |
| `importMime` | `audio/mpeg` for MP3 or `audio/mp4` for M4A, stored and served. |
| `importSize` | Source bytes, `audioSize`, and served bytes are equal. |
| `importDuration` | `audioDuration` is within one second of the source ffprobe duration. |
| `importSha256` | Source, stored `audioSha256`, and served audio hashes are equal. |
| `suffixRange` | A suffix range returns the last source bytes. |
| `outOfRange` | `bytes=<size>-` returns HTTP 416 and `Content-Range: bytes */<size>`. |

Keep the original source file. Generation and retry do not repair an imported
recording. Resolve an import failure from the source and the import evidence.

## Verify subscriptions when requested

Follow [subscriptions.md](subscriptions.md) for separate series feeds, protected
URLs, and AntennaPod import.

## Human gate

Report these as pending until a person examines them:

- For Generated and BYOS: intelligibility, pronunciation, pacing, voice
  suitability, and factual or curricular correctness when applicable.
- For imported recordings: the correct recording, an audible start and end, and
  listening quality. Equal bytes do not prove that the source was correct.
- For every branch: whether the episode gave the intended listener outcome.

Mechanical success never means that a human gate passed.
