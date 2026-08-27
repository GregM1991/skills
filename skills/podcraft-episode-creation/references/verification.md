# Episode verification contract

Generation, delivery, and listening quality are separate gates.

## Wait for a terminal result

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" wait <episode-id>
```

The command polls `episode.get` until `ready` or `failed`, prints status changes
to stderr, and writes the final episode JSON to stdout. It never starts or
retries generation. Override the one-hour bound only when the expected episode
length warrants it:

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" wait <episode-id> \
  --timeout-seconds 7200 \
  --interval-seconds 10
```

The production gate passes only when status is `ready`, the episode ID is
nonempty, `audioDuration` is positive, and `error` is empty. Preserve `error`
and `failedStep` from a failed result. A creation command is never a retry
command.

## Verify delivery

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" verify <episode-id>
```

The command checks the production gate, episode page, one-byte audio range, and
series RSS membership. It prints JSON containing the episode, audio, and feed
URLs plus each gate result. Exit code `0` means every mechanical gate passed.

## Human gate

Report these as pending until a person evaluates them:

- intelligibility and pronunciation;
- pacing and voice suitability;
- factual or curricular correctness when applicable;
- whether the episode achieved its intended listener outcome.

Mechanical success never implies a passed human gate.
