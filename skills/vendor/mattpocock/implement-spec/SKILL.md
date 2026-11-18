---
name: implement-spec
description: "Implement the result of /to-spec and /to-tickets in code."
disable-model-invocation: true
---

You have been provided a spec. This spec should have tickets associated with it, describing how to implement the spec.

The issue tracker should have been provided to you. If not, tell the user to run `/setup-matt-pocock-skills`.

The goal is the entire spec implemented on a single **integration branch**, with every ticket resolved the way the issue tracker closes work.

The tickets are not a list of steps. They are a **task graph** with blocking relationships between them. This means there is always a **frontier** of tickets which are ready to be grabbed.

Start every subagent with a fresh context window.

Communication to and from subagents should be sparse. Communicate primarily through **context pointers**: to the spec, tickets, research notes, and previous commits. Don't duplicate information already available via pointers.

**Implementer subagents** should be run in the background where possible for maximum concurrency.

## Steps

1. Read the spec and tickets to understand the task graph.

2. (optional) Use an **exploration subagent** to conduct any exploration required by the tickets - relevant codebase files or external documentation. Ensure the exploration subagent can save files - it should save its markdown notes in a directory outside the repo, accessible by all future subagents. This lets **implementer subagents** focus on implementation rather than exploration.

3. Create the integration branch. If the issue tracker closes work through PRs, or the user asks for one, open a draft PR after the first merge in step 5 (a branch with no commits ahead of main can't open one), marked as closing the spec and tickets.

4. Use a fresh **implementer subagent** for each ticket, each in its own worktree on its own branch. Each implementer subagent:
   - confirms its worktree is based on the integration branch before starting, and resets onto it if not;
   - calls the Skill tool with `tdd` to build the ticket;
   - merges the integration branch tip into its own branch before reporting done

5. Once an **implementer subagent** completes, merge its work to the integration branch with a **merger subagent**.

6. If this changes the **frontier** of available tickets, kick off more **implementer subagents** to work on the new tickets. This allows for maximum concurrency.

7. Once all tickets are complete, call the Skill tool with `code-review` on the integration branch. Fix all issues raised by the code review in a single fresh **implementer subagent**.

8. If a draft PR exists, mark it ready for review. Otherwise, resolve each ticket the way the issue tracker closes work, and report the integration branch.

9. Clean up all **implementer subagent** worktrees.

## Shared-owner coordination

**Implementer subagents** work in separate worktrees and cannot see each other's code. You see every ticket. Use that view to stop a second owner of a rule before its code exists.

- Keep the **shared-owner map** in the exploration notes directory. Seed it from the tickets' **Shared owners** sections or the map comment on the parent issue. Point every implementer subagent at the map and at the skills its ticket lists.
- **Plan check.** Before writing code, each implementer subagent writes a plan of at most 15 lines to the notes directory: the exported symbols, rules, constants, fixtures and test helpers it will add, and the existing owners it will reuse. It then stops and reports the plan path. Compare the plan with the map, the integration branch and the plans of implementers still running. Continue the same subagent with **go**, or with the owner it must use instead. When a plan adds something another ticket needs, add it to the map with one owner and tell the running implementers it affects.
- **Merge check.** Before merging, the **merger subagent** searches the integration branch for an existing owner of each rule, helper or fixture the ticket adds. A second owner goes back to an implementer subagent to consolidate before the merge.

Coordination is done when every entry in the map has exactly one owner on the integration branch.

## Simplification before code review

Before calling `code-review`, start a fresh reviewer subagent with no implementation conversation. It reads and follows `~/.agents/skills/simplification-review/SKILL.md` (a user-invoked skill, so pass the file rather than calling the Skill tool) against the integration branch, with the spec and tickets as requirements. Apply its supported recommendations in a single implementer subagent. Carry its exploration tasks and open decisions into the PR description or final report for the user. Then run `code-review` on the result.

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
