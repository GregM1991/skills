---
name: triage-scripts
description: Scripts for the triage skill. They list the GitHub issues and PRs that need triage, and apply a triage outcome (labels, comment, close) with a check after it. Use when the triage skill tells you to.
---

# Triage scripts

These scripts do the mechanical work of the `triage` skill on a GitHub tracker. They query the tracker, map roles to labels, post, close, and check the result. You keep the judgment: category, state, verification, grilling, and the comment text.

## Set up

Set `TRIAGE_SCRIPTS` to the absolute directory that contains this `SKILL.md`. Run from inside the target repository with Bun and an authenticated `gh`. The script reads `docs/agents/triage-labels.md` and `docs/agents/issue-tracker.md`. Use `--config-dir` to change that location and `--repo owner/repo` to change the repository. If the output says that the label map is missing, tell the user to run `/setup-matt-pocock-skills`.

The script prints JSON. Exit code 2 means it refused and wrote nothing: read `plan.errors`. Exit code 1 means an error, or a result that did not verify: read `problems`.

## List what needs attention

```bash
bun "$TRIAGE_SCRIPTS/scripts/triage.ts" queue
```

The output has these lists, oldest first:

- `conflicts`: items with more than one state role. Show these first and ask the maintainer how to resolve them.
- `unlabeled`: items with no state role.
- `needsTriage`: items with the `needs-triage` role.
- `needsInfoActive`: `needs-info` items where the reporter commented after the last triage notes.

Each item has `kind` (`issue` or `pr`), `title`, and `excerpt`. Use them for the one-line summaries. The script includes only external PRs, and only when the tracker config puts PRs in scope. It skips items that have a `wayfinder:*` label and no state role, because Wayfinder owns them. `skippedWayfinder` gives the count.

## Apply an outcome

Write the comment to a file. Then run `apply` with `--dry-run` and read the plan:

```bash
bun "$TRIAGE_SCRIPTS/scripts/triage.ts" apply 42 --state ready-for-agent --category bug --comment-file /tmp/brief.md --dry-run
```

Run the same command without `--dry-run` to apply it. The script:

- Removes the other state role and, with `--category`, the other category role.
- Adds the triage disclaimer to the comment if it is not there, and posts the comment.
- Closes a `wontfix` item as not planned.
- Reads the item again and checks the roles and the state.

It refuses `needs-info` and `wontfix` without a comment. It refuses an item whose state roles conflict until the maintainer decides; then add `--allow-conflict`. Report the `commentUrl` and the final labels.
