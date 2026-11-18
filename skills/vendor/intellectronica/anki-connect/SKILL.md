---
name: anki-connect
description: This skill is for interacting with Anki through AnkiConnect, and should be used whenever a user asks to interact with Anki, including to read or modify decks, notes, cards, models, media, or sync operations.
---

# AnkiConnect

## Overview

Enable reliable interaction with Anki through the AnkiConnect local HTTP API. Use this skill to translate user requests into AnkiConnect actions, craft JSON requests, run them via curl/jq (or equivalent tools), and interpret results safely.

## Preconditions and Environment

- If Anki is not running, launch Anki, then wait until the AnkiConnect server responds at `http://127.0.0.1:8765` (default). Verify readiness using curl, e.g. `curl -sS http://127.0.0.1:8765` should return `Anki-Connect`.

## Safety and Confirmation Policy (Critical)

**CRITICAL — NO EXCEPTIONS**

Before any destructive or modifying operation on **notes or cards** (adding, updating, deleting, rescheduling, suspending, unsuspending, changing deck, or changing fields/tags), request confirmation from the user. Use the **AskUserQuestion** tool if available; otherwise ask via chat. Only request confirmation **once** per logical operation, even if it requires multiple API calls (e.g., search + update + verify). Group confirmation by intent and scope (e.g., “Update 125 notes matching query X”).

Treat the following as confirmation-required by default:

- Notes: `addNote`, `addNotes`, `updateNoteFields`, `updateNoteTags`, `updateNote`, `updateNoteModel`, `deleteNotes`, `removeEmptyNotes`, `replaceTags`, `replaceTagsInAllNotes`, `clearUnusedTags`.
- Cards: `setEaseFactors`, `setSpecificValueOfCard`, `suspend`, `unsuspend`, `forgetCards`, `relearnCards`, `answerCards`, `setDueDate`, `changeDeck`.
- Deck or model modifications that materially change cards/notes (deck deletion, model edits). Ask even if the action is not explicitly listed above.

## API Fundamentals

### Request Format

Every request is JSON with:

- `action`: string action name
- `version`: API version (use `6` unless user specifies otherwise)
- `params`: object of parameters (optional)

### Response Format

Every response is JSON with:

- `result`: return value
- `error`: `null` on success or a string describing the error

Always check `error` before using `result`.

### Permissions

- Use `requestPermission` first when interacting from a non-trusted origin; it is the only action that accepts any origin.
- Use `version` to ensure compatibility; older versions may omit the `error` field in responses when `version` ≤ 4.

## curl + jq Patterns

Prefer `jq` to build JSON and parse responses. Keep requests explicit and structured.

### Minimal request template

```bash
jq -n --arg action "deckNames" --argjson version 6 '{action:$action, version:$version}' \
| curl -sS http://127.0.0.1:8765 -X POST -H 'Content-Type: application/json' -d @-
```

### With params

```bash
jq -n \
	--arg action "findNotes" \
	--argjson version 6 \
	--arg query "deck:French tag:verbs" \
	'{action:$action, version:$version, params:{query:$query}}' \
| curl -sS http://127.0.0.1:8765 -X POST -H 'Content-Type: application/json' -d @-
```

### Handling result/error

```bash
curl -sS http://127.0.0.1:8765 -X POST -H 'Content-Type: application/json' -d @- \
| jq -e 'if .error then halt_error(1) else .result end'
```

### Batching multiple actions

Use `multi` to reduce round-trips and to group actions under a single confirmation when modifying data.

```bash
jq -n --argjson version 6 --arg query "deck:French" \
	'{action:"multi", version:$version, params:{actions:[
		{action:"findNotes", params:{query:$query}},
		{action:"notesInfo", params:{notes:[]}} 
	]}}' \
| curl -sS http://127.0.0.1:8765 -X POST -H 'Content-Type: application/json' -d @-
```

Replace the empty array with the result of the previous action when chaining; in CLI usage, split into two calls unless using a scripting language.

## Core Workflow Guidance

### 1) Verify connectivity and version

- Call `requestPermission` (safe).
- Call `version` to confirm the API level and use `version: 6` in requests.

### 2) Discover supported actions

- Use `apiReflect` with `scopes: ["actions"]` to list supported actions.
- Use this list to map user intent to action names.

### 3) Resolve user request into action sequence

- Identify read-only vs destructive operations.
- For destructive/modifying operations on notes/cards, request confirmation once with the scope and count.
- Prefer `findNotes`/`findCards` + `notesInfo`/`cardsInfo` for previews before modification.

### 4) Execute and validate

- Execute the call(s) in order.
- Check `error` for each response.
- Report summarized results and any IDs returned.

## Common Task Recipes (CLI-Oriented)

### List decks

- Action: `deckNames`

### Create deck

- Action: `createDeck`
- Confirmation required if the deck is being created as part of a card/note modification workflow.

### Search notes / cards

- Actions: `findNotes`, `findCards`
- Use Anki search syntax (see “Search Syntax Quick Notes” below).

### Preview note data

- Action: `notesInfo` (note IDs)

### Add notes

- Actions: `addNote`, `addNotes`
- Confirmation required.
- Use `canAddNotes` or `canAddNotesWithErrorDetail` for preflight checks.

### Update note fields or tags

- Actions: `updateNoteFields`, `updateNoteTags`, or combined `updateNote`
- Confirmation required.
- Warning: Do not have the note open in the browser; updates may fail to apply.

### Delete notes

- Action: `deleteNotes`
- Confirmation required.

### Suspend/unsuspend cards

- Actions: `suspend`, `unsuspend`
- Confirmation required.

### Move cards to a deck

- Action: `changeDeck`
- Confirmation required.

### Set due date or reschedule

- Action: `setDueDate`
- Confirmation required.

### Media upload/download

- Actions: `storeMediaFile`, `retrieveMediaFile`, `getMediaFilesNames`, `getMediaDirPath`, `deleteMediaFile`
- Use base64 (`data`), file path (`path`), or URL (`url`) for upload.

### Sync

- Action: `sync`

## Search Syntax Quick Notes (for `findNotes`/`findCards`)

- Separate terms by spaces; terms are ANDed by default.
- Use `or`, parentheses, and `-` for NOT logic.
- Use `deck:Name`, `tag:tagname`, `note:ModelName`, `card:CardName`.
- Use `front:...` or other field names to limit by field.
- Use `re:` for regex, `w:` for word-boundary searches, `nc:` to ignore accents.
- Use `is:due`, `is:new`, `is:learn`, `is:review`, `is:suspended`, `is:buried` to filter card states.
- Use `prop:` searches for properties like interval or due date.
- Escape special characters with quotes or backslashes as needed.

## Action Catalog (Use as a mapping reference)

### Card Actions

- `getEaseFactors`
- `setEaseFactors`
- `setSpecificValueOfCard`
- `suspend`
- `unsuspend`
- `suspended`
- `areSuspended`
- `areDue`
- `getIntervals`
- `findCards`
- `cardsToNotes`
- `cardsModTime`
- `cardsInfo`
- `forgetCards`
- `relearnCards`
- `answerCards`
- `setDueDate`

### Deck Actions

- `deckNames`
- `deckNamesAndIds`
- `getDecks`
- `createDeck`
- `changeDeck`
- `deleteDecks`
- `getDeckConfig`
- `saveDeckConfig`
- `setDeckConfigId`
- `cloneDeckConfigId`
- `removeDeckConfigId`
- `getDeckStats`

### Graphical Actions

- `guiBrowse`
- `guiSelectCard`
- `guiSelectedNotes`
- `guiAddCards`
- `guiEditNote`
- `guiAddNoteSetData`
- `guiCurrentCard`
- `guiStartCardTimer`
- `guiShowQuestion`
- `guiShowAnswer`
- `guiAnswerCard`
- `guiUndo`
- `guiDeckOverview`
- `guiDeckBrowser`
- `guiDeckReview`
- `guiImportFile`
- `guiExitAnki`
- `guiCheckDatabase`
- `guiPlayAudio`

### Media Actions

- `storeMediaFile`
- `retrieveMediaFile`
- `getMediaFilesNames`
- `getMediaDirPath`
- `deleteMediaFile`

### Miscellaneous Actions

- `requestPermission`
- `version`
- `apiReflect`
- `sync`
- `getProfiles`
- `getActiveProfile`
- `loadProfile`
- `multi`
- `exportPackage`
- `importPackage`
- `reloadCollection`

### Model Actions

- `modelNames`
- `modelNamesAndIds`
- `findModelsById`
- `findModelsByName`
- `modelFieldNames`
- `modelFieldDescriptions`
- `modelFieldFonts`
- `modelFieldsOnTemplates`
- `createModel`
- `modelTemplates`
- `modelStyling`
- `updateModelTemplates`
- `updateModelStyling`
- `findAndReplaceInModels`
- `modelTemplateRename`
- `modelTemplateReposition`
- `modelTemplateAdd`
- `modelTemplateRemove`
- `modelFieldRename`
- `modelFieldReposition`
- `modelFieldAdd`
- `modelFieldRemove`
- `modelFieldSetFont`
- `modelFieldSetFontSize`
- `modelFieldSetDescription`

### Note Actions

- `addNote`
- `addNotes`
- `canAddNotes`
- `canAddNotesWithErrorDetail`
- `updateNoteFields`
- `updateNote`
- `updateNoteModel`
- `updateNoteTags`
- `getNoteTags`
- `addTags`
- `removeTags`
- `getTags`
- `clearUnusedTags`
- `replaceTags`
- `replaceTagsInAllNotes`
- `findNotes`
- `notesInfo`
- `notesModTime`
- `deleteNotes`
- `removeEmptyNotes`

### Statistic Actions

- `getNumCardsReviewedToday`
- `getNumCardsReviewedByDay`
- `getCollectionStatsHTML`
- `cardReviews`
- `getReviewsOfCards`
- `getLatestReviewID`
- `insertReviews`

## Notes and Pitfalls

- Keep Anki in the foreground on macOS or disable App Nap to prevent AnkiConnect from pausing.
- When updating a note, ensure it is not being viewed in the browser editor; updates may not apply.
- `importPackage` paths are relative to the Anki `collection.media` folder, not the client.
- `deleteDecks` requires `cardsToo: true` to delete cards along with decks.

## Resources

No bundled scripts or assets are required for this skill.

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
