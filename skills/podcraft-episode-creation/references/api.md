# Podcraft API client

The bundled [client](../scripts/podcraft_api.py) handles Podcraft's tRPC queries,
series creation, Generated/BYOS creation, and basic delivery verification. Audio imports use the
multipart endpoint or local CLI described in [imports.md](imports.md).

## Connection

The default base URL is the current server's Tailscale DNS name:
`http://gm-home-server.geep-clownfish.ts.net:5200`.

Set this variable for the curl examples as well as the bundled client:

```bash
export PODCRAFT_API_BASE_URL=http://100.87.53.41:5200
```

Podcraft currently has no API token or login. Network policy is the only access
control. The server must bind to a tailnet-reachable address, the caller must be
connected to the same tailnet, and TCP port 5200 must be allowed between them.
Use this private application origin for management and uploads. The protected
subscription gateway serves feeds and media only. The server's `FEED_BASE_URL`
must also be reachable by the caller for feed audio links to work.

## Read-only preflight

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" series
```

`series` supplies each existing slug and ID. The bundled creation commands and
local import CLI take a slug; the multipart import endpoint takes the series ID.

## Create a missing series

Creating a series is a write. Run the dry run, present its payload, and submit
once only after the user authorizes that series:

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" series create \
  --title "$SERIES_TITLE" \
  --slug "$SERIES_SLUG" \
  --description "$SERIES_DESCRIPTION" \
  --dry-run
```

Optional flags are `--voice` (default `af_heart`), `--persona-id`, `--category`
(default `Technology`), `--author` (default `AI Podcast`), `--image-url`, and
`--default`. The slug is permanent and becomes the feed path
`/api/feed/<slug>`. It is 1 to 100 lowercase letters, digits, and single
hyphens; `new`, `edit`, `api`, `settings`, and `episodes` are reserved. The title
is at most 200 characters and the description at most 2,000.

The dry run and the submission both validate voice and persona against the
service and fail when the slug already exists. Use the existing series in that
case. With `--default`, the plan names the series in `replacesDefault`, which
loses default status. Success prints the new series object with its `id`. If the
response is lost, run `series` and look for the slug before another attempt.

For Generated and BYOS, require full readiness and resolve the voice:

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" health --ready
python3 "$SKILL_DIR/scripts/podcraft_api.py" voices
```

For imports, inspect the readiness response directly:

```bash
curl --silent --show-error --connect-timeout 10 --max-time 20 \
  "$PODCRAFT_API_BASE_URL/api/health?ready=true"
```

Require `checks.db.ok` and `checks.ffprobe.ok` to be `true`. Read the JSON even if
the response is HTTP 503. TTS and script-generator failures can make full readiness
degraded while imports remain usable. If either required check is missing or
false, resolve it before submission. Local audio extraction also needs FFmpeg.

Inspect an episode without waiting:

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" status "$EPISODE_ID"
```

The client's data commands write JSON to stdout and diagnostics to stderr.
Set `PODCRAFT_API_BASE_URL` or pass global `--base-url` before the subcommand.

For an ambiguous submission, use paginated `episode.list` for the selected series
and `episode.get` for candidate details. The client's `iter_series_episodes`
performs these read-only calls. List results omit import hashes and source IDs;
episode detail includes them.
