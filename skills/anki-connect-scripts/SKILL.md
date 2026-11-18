---
name: anki-connect-scripts
description: Script for anki-connect that sends AnkiConnect requests, previews scope, and applies and verifies a batch of changes.
disable-model-invocation: true
---

# AnkiConnect scripts

`scripts/anki.ts` does the mechanical steps of the `anki-connect` skill. The `anki-connect` skill tells the agent when to run each command. Run `bun scripts/anki.ts --help` for commands, options and exit codes.

Every action that is not on the read-only list in the script needs `--confirmed`. `apply` verifies these actions by reading them back: `addNote`, `addNotes`, `updateNoteFields`, `updateNote`, `updateNoteTags`, `addTags`, `removeTags`, `deleteNotes`, `suspend`, `unsuspend` and `changeDeck`. It lists other write actions as `unverified`.

## Maintain

Run `bun test` in this directory. The tests use an in-memory fake AnkiConnect. They never connect to a real Anki collection.
