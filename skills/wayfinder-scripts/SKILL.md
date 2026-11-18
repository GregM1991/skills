---
name: wayfinder-scripts
description: Scripts for the GitHub tracker steps of wayfinder, wayfinder-stand-in and to-tickets (frontier, claim, resolve, create tickets, stand-in tick). Use when one of those skills tells you to use a helper script.
---

# Wayfinder scripts

These commands do the fixed tracker steps: read, filter, sort, claim, comment, close, link, and verify. You do the judgment: the questions, the answers, the gists, the fog, and the scope.

## Run a command

Set `WAYFINDER_SCRIPTS` to the absolute directory of this `SKILL.md`. Use Bun and an authenticated `gh` CLI. Run the command in the target clone, or add `--repo owner/repo`. An issue URL also sets the repository.

```bash
bun "$WAYFINDER_SCRIPTS/scripts/wayfinder.ts" <command> ...
```

| Command | What it does |
| --- | --- |
| `frontier <map>` | Reads the open child tickets of the map. Prints `frontier` (open, unblocked, unclaimed, in map order), `blocked`, `claimed`, and `closed`. `first` is the next ticket. |
| `claim <ticket>...` | Assigns the tickets to the `gh` user. Refuses all of them when one is closed, blocked, or claimed by a different user. |
| `resolve <ticket> --map <map> --answer-file <file> --gist "<line>"` | Posts the file as the resolution comment, closes the ticket, and adds `- [<title>](<url>): <gist>` to the map's **Decisions so far**. With `--out-of-scope`, it closes the ticket as not planned and adds the line to **Out of scope**. You can run it again after a failure. |
| `create-tickets --plan <plan.json>` | Creates the tickets with blockers first. Makes each ticket a sub-issue of the plan's `parent`, sets native blocked-by links, changes `{{key}}` references to real ids, and posts `parentComment` on the parent. It keeps its progress in `<plan.json>.state.json`, so a second run continues. For the plan format, read [plan format](references/plan-format.md). |
| `tick <map>` | The `wayfinder-stand-in` loop. That skill tells how to use it. |

Each command that writes accepts `--dry-run`. Each write is read again to verify it.

## Read the result

Each command prints JSON. The exit code tells the result:

- `0`: Done and verified.
- `2`: Refused. The command wrote nothing. The `error` field gives the cause. Correct the cause, or do the step manually as the calling skill tells.
- `1`: An error, or a write that did not verify. Read `problems` or `error`. Examine the tracker before you run the command again.

The scripts need GitHub native sub-issues and issue dependencies. For a different tracker, do the steps manually.
