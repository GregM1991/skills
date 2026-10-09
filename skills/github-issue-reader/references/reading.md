# Saved content and native relationships

Keep `ISSUE_READER_SKILL` set to the directory of the loaded skill. Use its script's `--help` for accepted arguments and current output limits.

## Read omitted content

Reuse the printed snapshot path to avoid another GitHub request:

```bash
bun "$ISSUE_READER_SKILL/scripts/issue-read.ts" --snapshot /path/to/snapshot.json --section body --offset 3500
bun "$ISSUE_READER_SKILL/scripts/issue-read.ts" --snapshot /path/to/snapshot.json --section comments --offset 20
bun "$ISSUE_READER_SKILL/scripts/issue-read.ts" --snapshot /path/to/snapshot.json --comment 123456 --offset 0
```

Body and individual comment offsets count characters. Comment, child, and blocker index offsets count entries. Use the returned `nextOffset` for continuation. `nextOffset: null` means that section is complete. A comment preview is an index entry. Read the full relevant comment through `--comment` before relying on it.

Full validated titles, labels, bodies, comments, and relationship metadata remain in the snapshot. If a title or label is truncated, use a targeted read of that snapshot field. Keep snapshot contents in private temporary storage and print only the fields needed for the task. The reader creates each snapshot directory with mode `0700` and its file with mode `0600`.

## Read native relationships

```bash
bun "$ISSUE_READER_SKILL/scripts/issue-read.ts" <number> --section children
bun "$ISSUE_READER_SKILL/scripts/issue-read.ts" <number> --section parent
bun "$ISSUE_READER_SKILL/scripts/issue-read.ts" <number> --section blockers
bun "$ISSUE_READER_SKILL/scripts/issue-read.ts" --snapshot /path/to/snapshot.json --section children --offset 20
bun "$ISSUE_READER_SKILL/scripts/issue-read.ts" --snapshot /path/to/snapshot.json --section parent
bun "$ISSUE_READER_SKILL/scripts/issue-read.ts" --snapshot /path/to/snapshot.json --section blockers --offset 20
```

Every fresh read saves all comment, direct child, and blocker pages plus the immediate parent. Blockers are issues that block the selected ticket. Only open blockers prevent work. Closed blockers remain available as context. Read a related ticket's body and comments with a separate invocation using its issue number and repository from its URL.

GitHub's native [sub-issue endpoints](https://docs.github.com/en/rest/issues/sub-issues) and [issue dependency endpoints](https://docs.github.com/en/rest/issues/issue-dependencies) own these links. Markdown task lists and blocker lines may describe intent, but cannot replace a failed native lookup.

## Handle failures

A confirmed absence of a parent prints `parent: null`. The reader accepts only GitHub's explicit `No parent issue found` response with status `404` as that absence. Other lookup failures or invalid data stop the read with a nonzero exit code. Report the failure and resolve repository access or authentication before making a decision that needs those links.

Older snapshots still expose body and comments but print `relationships.available: false`. Fetch the issue again before requesting their relationship sections. Saved snapshots keep their original fetch time and never refresh themselves.

## Maintain the helper

The skill owns its runtime dependency and lockfile. Run `bun install --cwd "$ISSUE_READER_SKILL" --frozen-lockfile`, then `bun run --cwd "$ISSUE_READER_SKILL" test` after changing the reader. Tests exercise the CLI against a fake `gh` executable, including pagination, private snapshots, repository selection, and lookup failures.
