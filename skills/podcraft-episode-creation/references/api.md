# Podcraft API client

The bundled [client](../scripts/podcraft_api.py) hides Podcraft's tRPC wire
format. Run it from any machine with Python 3 that can reach the service.

## Connection

The default base URL is the current server's Tailscale DNS name:
`http://gm-home-server.geep-clownfish.ts.net:5200`.

Override it when MagicDNS is unavailable or another Podcraft service is in use:

```bash
export PODCRAFT_API_BASE_URL=http://100.87.53.41:5200
```

Podcraft currently has no API token or login. Network policy is the only access
control. The server must bind to a tailnet-reachable address, the caller must be
connected to the same tailnet, and TCP port 5200 must be allowed between them.
Keep that port blocked on unintended interfaces. The server's `FEED_BASE_URL`
must also be reachable by the caller for feed audio links to work.

## Read-only preflight

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" health --ready
python3 "$SKILL_DIR/scripts/podcraft_api.py" series
python3 "$SKILL_DIR/scripts/podcraft_api.py" voices
```

`health --ready` checks the database, text-to-speech service, script generators,
and FFmpeg. A degraded result exits nonzero. `series` supplies the slugs accepted
by the create commands.

Inspect an episode without waiting:

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" status <episode-id>
```

Every command writes machine-readable JSON to stdout and diagnostics to stderr.
Set `PODCRAFT_API_BASE_URL` or pass global `--base-url` before the subcommand.
