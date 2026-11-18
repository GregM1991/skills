---
name: implement-spec-tick
description: Script for implement-spec that prints the ticket frontier and next action, and creates, merges and removes ticket worktrees.
disable-model-invocation: true
---

# implement-spec tick

`scripts/impl-tick.ts` does the mechanical steps of the `implement-spec` skill. The `implement-spec` skill tells the agent when to run each command. Run `bun scripts/impl-tick.ts --help` for commands, options and exit codes.

## Ticket states

The tick finds each state from the tracker and from git. It keeps no state file.

- **closed**: the tracker closed the ticket.
- **merged**: a merge commit on the integration branch carries the `Impl-Tick-Ticket: <id>` trailer.
- **running**: the branch `<integration>-t<id>` exists.
- **ready**: every blocker is merged or closed.
- **blocked**: a blocker is open, or a local "Blocked by" line names no known ticket.

A GitHub spec reads its native sub-issues and their blockers through the `github-issue-reader` skill. That skill must be installed next to this one, or `ISSUE_READER_SKILL` must name its directory. A local spec is a directory of `NN-slug.md` ticket files, as `to-tickets` writes them.

## Maintain

Run `bun test` in this directory. The tests use throwaway git repositories in a temporary directory and a fake issue reader.
