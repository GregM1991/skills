# Episode verification contract

Readiness, delivery, and listening quality are separate gates.

## Confirm the episode

Generated and BYOS submissions require a wait:

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" wait "$EPISODE_ID"
```

The command polls `episode.get` until `ready` or `failed`, prints status changes
to stderr, and writes the final episode JSON to stdout. It never starts or
retries generation. Override the one-hour bound only when the expected episode
length warrants it:

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" wait "$EPISODE_ID" \
  --timeout-seconds 7200 \
  --interval-seconds 10
```

Imports return a ready episode. Inspect it directly:

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" status "$EPISODE_ID"
```

For every branch, require status `ready`, a nonempty episode ID, positive
`audioDuration` and `audioSize`, an audio path, and an empty `error`. Preserve
`error` and `failedStep` from a failed result. Imported audio must retain
`sourceType=imported`, the expected source ID, series, and episode number, with
an empty script. Resolve an unavailable import from its source and import
evidence; generation and retry do not repair imported recordings.

## Verify delivery

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" verify "$EPISODE_ID"
```

The command checks the ready state, episode page, a one-byte audio range, and
series RSS membership. It prints JSON containing the episode, audio, and feed
URLs plus each gate result. Require exit code zero, then confirm the branch's
additional checks below. The command does not compare full audio hashes or parse
RSS enclosure metadata.

For every episode, inspect its RSS item by exact GUID. Require the expected
episode number, enclosure URL, byte length, and MIME type. Check GET and HEAD on
the audio, including `Content-Length` and `Accept-Ranges: bytes`. The one-byte
request must return HTTP 206, one byte, and `Content-Range: bytes 0-0/<size>`.

## Verify imported bytes

Match the MIME type to the imported format: `audio/mpeg` for MP3 and `audio/mp4`
for M4A AAC. Require the served length and stored `audioSize` to equal the source
byte count. Compare `audioDuration` with the source's ffprobe result, within one
second.

Compare three SHA-256 values: the source file, `audioSha256` from episode detail,
and the complete served audio. Save the served audio in a private temporary
directory, using the audio URL returned by verification:

```bash
curl --fail --silent --show-error --max-time 1800 \
  --output "$EVIDENCE_DIR/served-audio" "$AUDIO_URL"
sha256sum -- "$AUDIO_FILE" "$EVIDENCE_DIR/served-audio"
```

Require a successful download before comparing hashes. Use a directory with mode
0700 and retain the source. Also check a suffix range and an out-of-bounds range:
the former must match the source bytes; the latter must return HTTP 416 with
`Content-Range: bytes */<size>`. A passed basic `verify` result alone does not
complete the import checks.

## Verify subscriptions when requested

Follow [subscriptions.md](subscriptions.md) for separate series feeds, protected
URLs, and AntennaPod import. Check the subscriber's actual feed and enclosure
URLs, not only the private application endpoints. Preserve GUIDs and numbering
through the gateway and require the same MIME and byte-range behavior.

## Human gate

Report these as pending until a person evaluates them:

- For Generated and BYOS: intelligibility, pronunciation, pacing, voice
  suitability, and factual or curricular correctness when applicable.
- For imported recordings: the intended recording, audible start and end, and
  listening quality. Byte identity alone does not prove the source was correct.
- For every branch: whether the episode achieved its intended listener outcome.

Mechanical success never implies a passed human gate.
