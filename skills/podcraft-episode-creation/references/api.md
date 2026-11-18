# Podcraft API client

The bundled [client](../scripts/podcraft_api.py) does all Podcraft service calls
for this skill: series, Generated and BYOS creation, audio imports,
reconciliation, and delivery checks. Run `podcraft_api.py <command> --help` for
the flags of a command.

## Connection

The default base URL is the current server's Tailscale DNS name:
`http://gm-home-server.geep-clownfish.ts.net:5200`. To change it, set
`PODCRAFT_API_BASE_URL`, or give `--base-url` before the command:

```bash
export PODCRAFT_API_BASE_URL=http://100.87.53.41:5200
```

Podcraft has no API token or login. Network policy is the only access control.
The server must bind to a tailnet address, the caller must be on the same
tailnet, and TCP port 5200 must be open between them. The server's
`FEED_BASE_URL` must also be reachable, because RSS audio links use it.

## Output and exit codes

Data goes to stdout as JSON. Diagnostics go to stderr. Exit 0 means success or
all gates passed. Exit 1 means an error or a failed gate. `wait` uses 2 for a
failed episode and 3 for a timeout. `import` uses 4 when the outcome is unknown.

## Readiness

For Generated and BYOS, require full readiness and resolve the voice:

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" health --ready
python3 "$SKILL_DIR/scripts/podcraft_api.py" voices
```

Imports need only the database and ffprobe. A TTS failure can make full
readiness `degraded` while imports stay usable. `import --dry-run` does this
check. To do it alone:

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" health --require db --require ffprobe
```

## Series

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" series
```

This lists each series with its slug and ID. All commands take the slug.

A new series is a write. Run the dry run, show its payload to the user, and
submit once only after the user authorizes that series:

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" series create \
  --title "$SERIES_TITLE" \
  --slug "$SERIES_SLUG" \
  --description "$SERIES_DESCRIPTION" \
  --dry-run
```

Optional flags are `--voice` (default `af_heart`), `--persona-id`, `--category`
(default `Technology`), `--author` (default `AI Podcast`), `--image-url`, and
`--default`. The slug is permanent and becomes the feed path `/api/feed/<slug>`.
The client validates the slug, title, and description limits, and the voice and
persona against the service. It fails when the slug exists; then use the
existing series. With `--default`, `replacesDefault` names the series that loses
default status. Success prints the new series with its `id`. If the response is
lost, run `series` and look for the slug before another attempt.

## Episodes

Get one episode without a wait:

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" status "$EPISODE_ID"
```

If a submission response is lost or unclear, find the episode before another
submission. Give the values of that submission:

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" reconcile --series "$SERIES_SLUG" \
  --title "$TITLE" --script-file "$SCRIPT_FILE"
```

Use `--topic` for Generated, `--title` and `--script-file` for BYOS, and
`--source-id` and `--file` for imports. Read `outcome`: `one` is a full match,
`none` is no match, and `review` needs you to compare `matched` and `differs`
for each candidate.
