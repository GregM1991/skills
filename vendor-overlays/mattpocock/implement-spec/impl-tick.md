## Ticket state with impl-tick

Use the `impl-tick` script for the mechanical steps. It replaces these hand steps above: finding the **frontier** (steps 1 and 6), worktree creation and the base check (step 4), the merge (step 5) and worktree clean-up (step 9). The judgment stays with you and your subagents: the plan check, merge conflicts, the merge check, the simplification review and the code review.

`TICK` is `bun ~/.agents/skills/implement-spec-tick/scripts/impl-tick.ts`. `<spec>` is the spec issue (a number, `owner/repo#number` or URL), whose native sub-issues are the tickets, or the local ticket directory. `<branch>` is the integration branch.

1. In the target checkout, run `TICK tick --spec <spec> --integration <branch>`. Do each entry in `next`, in order. Each entry gives the command to run.
   - `create-integration-branch`: create the branch from the base you choose (step 3).
   - `start`: run the command. It creates the ticket branch and worktree from the integration tip and verifies them, so the base check is complete. Start a fresh implementer subagent in the printed `worktree`, without harness worktree isolation. Give it the ticket URL as its context pointer.
   - `wait`: the implementer is at work. When it reports done, the merger subagent does the merge check, then runs the command.
   - `cleanup`: run the command. It removes the worktrees and branches of merged tickets.
   - `finish`: continue with the simplification review and `code-review`.
   - `stuck`: no ticket can start. Read `waitingOn` and `unparsedBlockers` on the blocked tickets, and resolve the blockers with the user.
2. Run the tick again after each `start`, each merge and each subagent report.

The implementer still merges the integration tip into its branch before it reports done. `merge` refuses a branch without the integration tip (`action: update-branch`) or with uncommitted changes (`action: commit-or-discard`). Send the refusal back to the implementer. A merge that passes has no conflicts. Its commit carries the `Impl-Tick-Ticket: <id>` trailer, which marks the ticket as merged.

Exit 0 is success. Exit 2 is a refusal, and the JSON tells you what to do first. Exit 1 is an error. If the issue read fails, run `bun install --cwd ~/.agents/skills/github-issue-reader --frozen-lockfile` and check `gh` authentication. Add `--dry-run` to `start`, `merge` or `cleanup` to see the change before it occurs. `TICK --help` lists all options.
