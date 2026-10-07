# Run helpers

Run the helper with Bun. Paths below are relative to this skill directory. Keep config and evidence outside application source. Config contains no credential values.

```json
{
  "environment": "dev",
  "requestedEnvironment": "dev",
  "target": { "environment": "dev", "url": "http://localhost:3000", "source": "project-config" },
  "revision": "abc123",
  "credentialReferences": ["op://Agents/qa-login/password"],
  "checks": ["target-route", "final-state", "desktop-flow"]
}
```

`environment` and `target.environment` must match. Set `requestedEnvironment` when the request names it. Conflicts stop validation. `source` is `request` or `project-config`; the agent must inspect that source before writing config. The helper validates declarations, not the truth of a deployment. URLs must contain no user information, query or fragment. Credentials may use `op://` references or `env:VARIABLE_NAME` references. Revision is a safe identifier or `unknown`. Check IDs use lower-case letters, digits and hyphens.

```bash
bun scripts/qa-run.ts init --config /private/qa-config.json --evidence /private/qa-2026-10-07
bun scripts/qa-run.ts reach --config /private/qa-config.json
bun scripts/qa-run.ts report --config /private/qa-config.json --evidence /private/qa-2026-10-07 --observations /private/qa-observations.json
```

`init` creates a new directory and `manifest.json`. It fails if that directory exists. The manifest omits credential references. `reach` prints only transport reachability and HTTP status; it proves no browser result. It follows no redirects and has a ten-second timeout.

Write observations after inspecting browser evidence:

```json
[
  { "id": "target-route", "outcome": "passed", "evidence": ["target-route.png"] },
  { "id": "final-state", "outcome": "failed", "evidence": ["final-state.png"] }
]
```

Evidence paths must be relative files inside the evidence directory. `report` requires the manifest to match the current config, writes `summary.json` and prints counts. Missing checks or evidence produce `untested`; an observed failure stays `failed`. All checks must pass with evidence, including `target-route` and `final-state`, for the reported outcome to be `passed`. Exit codes are 0 for passed, 1 for failed or untested, and 2 for invalid input or a helper error. The helper checks files, not their visual meaning. Inspect each artifact and write the human report with reproduction details. Keep secret values out of config, observations, filenames and captures; the helper cannot redact secrets embedded in images.
