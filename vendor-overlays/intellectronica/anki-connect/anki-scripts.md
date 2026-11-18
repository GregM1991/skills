## Scripted requests

Use the `anki.ts` script for every AnkiConnect request. It replaces these parts above: the "curl + jq Patterns", the `error` check on each response, the preview before a change in "Resolve user request into action sequence", "Execute and validate", and the "Resources" note. You keep the judgment: the action sequence, the confirmation question and the card content. When you write or revise cards, follow the `anki-card-standards` skill.

`ANKI` is `bun ~/.agents/skills/anki-connect-scripts/scripts/anki.ts`.

- **Read:** run `ANKI call <action> --params '<json>'`, for example `ANKI call findNotes --params '{"query":"deck:French"}'`. Use `--params @file.json` for large params and `--out file.json` for large results.
- **Change notes or cards:**
  1. Run `ANKI preview --query '<search>'` to get the scope: the note and card counts, the cards in each deck and sample notes.
  2. Write the actions to a plan file: `{"actions": [{"action": "...", "params": {...}}]}`.
  3. Run `ANKI apply --plan <file> --dry-run`. It shows the scope of each action and checks new notes with `canAddNotesWithErrorDetail`. Correct the plan if a note cannot be added.
  4. Ask the user once, with that scope, as the confirmation policy above says.
  5. After the user confirms, run `ANKI apply --plan <file> --confirmed`. It sends all actions in one `multi` batch, then reads the notes and cards back to verify them.
- A change through `call` also needs `--confirmed`, after the same confirmation.

Exit 0 is success. Exit 1 is an error, which includes an AnkiConnect `error`; for a failed plan, `results` shows which actions applied. Exit 2 is a refusal because `--confirmed` is missing. Exit 3 means that the change applied but did not read back as the plan says; tell the user the `mismatches`. The script reads `ANKI_CONNECT_URL` (default `http://127.0.0.1:8765`). `ANKI --help` lists all options.
