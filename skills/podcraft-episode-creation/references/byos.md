# BYOS episode contract

Use this branch when the supplied script is authoritative. Podcraft performs
text-to-speech, MP3 production, storage, and delivery without rewriting it.

## Inputs

Required:

- existing series slug;
- title: 1 to 200 characters after trimming;
- script file: 1 to 200,000 characters after trimming.

The selected series' configured voice is the default. Pass `--voice` only for
an explicit override.

## Preflight and create

Prefer an absolute script path so the authorized source remains unambiguous.
Run the same command first with `--dry-run`, then once without it after
authorization:

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" create byos \
  --series <series-slug> \
  --title "<title>" \
  --script-file <absolute-script-path> \
  --dry-run
```

The dry run reports the resolved series, voice, character count, and SHA-256
hash. It does not submit the script.

Before submission, the client checks existing episodes in the series for the
same trimmed title, script, and voice. `--allow-duplicate` bypasses this check
and requires explicit user authorization. This client-side check reduces
accidents but is not a cross-host lock.

Creation success requires exit code `0` and an episode object with a nonempty
`id`. It is an accepted background job, not a ready episode. Continue with the
wait and verification commands in [verification.md](verification.md).
