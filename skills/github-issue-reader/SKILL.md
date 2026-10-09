---
name: github-issue-reader
description: Read GitHub ticket bodies and comments, inspect native children, parents, and blockers, or retrieve omitted content from saved issue snapshots.
---

# GitHub issue reader

Use the bundled reader for issue content and native relationships. It saves complete validated data in a private snapshot and prints bounded JSON. Repository guidance owns ticket selection, claims, labels, and writes.

## Read the ticket

1. Resolve the repository and issue number from the request, issue URL, or project guidance. For discovery, use a bounded `gh issue list` with number, title, and labels, then read selected issues with this helper.
2. Set `ISSUE_READER_SKILL` to the absolute directory containing this loaded `SKILL.md`. Use Bun and an authenticated `gh` CLI. Install the skill's dependencies with the command below. Keep the current working directory in the target project so `gh` can infer its repository. Supply `--repo owner/repo` when outside that checkout or reading another repository.

   ```bash
   bun install --cwd "$ISSUE_READER_SKILL" --frozen-lockfile
   bun "$ISSUE_READER_SKILL/scripts/issue-read.ts" <number>
   ```

3. Inspect the returned repository, issue number, fetch time, body excerpt, comment index, and relationship counts. Confirm that they match the requested ticket. Read relevant omitted content through the printed snapshot path before deciding scope or acceptance. Follow `nextOffset` until each relevant section is complete. For commands, offsets, and failures, read [saved content and native relationships](references/reading.md).
4. Fetch again when a decision needs current issue or blocker state. Report the issue URL and findings supported by the content you read. Identify any unread relevant content or failed lookup. Remove the printed snapshot's containing directory when the task no longer needs that evidence.

The reader only performs GitHub reads. Follow the user's request and repository workflow for any later issue change or implementation.
