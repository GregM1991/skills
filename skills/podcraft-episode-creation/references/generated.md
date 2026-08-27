# Generated episode contract

Use this branch when Podcraft owns the script research and writing.

## Inputs

Required:

- existing series slug;
- topic: 1 to 1,000 characters after trimming;
- summary file: 1 to 50,000 characters after trimming.

Defaults:

- length: `medium`;
- voice: the selected series' configured voice.

Optional overrides are `--length short|medium|long|auto`, `--voice`,
`--persona-id`, and `--image-url`.

## Preflight and create

Prefer an absolute summary path so the authorized source remains unambiguous.
Run the same command first with `--dry-run`, then once without it after
authorization:

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" create generated \
  --series <series-slug> \
  --topic "<topic>" \
  --summary-file <absolute-summary-path> \
  --length medium \
  --dry-run
```

Append optional flags only for resolved overrides. The dry run reports the
resolved series, voice, character count, and SHA-256 hash. It does not submit
the summary.

Creation success requires exit code `0` and an episode object with a nonempty
`id`. It is an accepted background job, not a ready episode. Continue with the
wait and verification commands in [verification.md](verification.md).
