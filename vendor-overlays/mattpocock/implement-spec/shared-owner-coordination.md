## Shared-owner coordination

**Implementer subagents** work in separate worktrees and cannot see each other's code. You see every ticket. Use that view to stop a second owner of a rule before its code exists.

- Keep the **shared-owner map** in the exploration notes directory. Seed it from the tickets' **Shared owners** sections or the map comment on the parent issue. Point every implementer subagent at the map and at the skills its ticket lists.
- **Plan check.** Before writing code, each implementer subagent writes a plan of at most 15 lines to the notes directory: the exported symbols, rules, constants, fixtures and test helpers it will add, and the existing owners it will reuse. It then stops and reports the plan path. Compare the plan with the map, the integration branch and the plans of implementers still running. Continue the same subagent with **go**, or with the owner it must use instead. When a plan adds something another ticket needs, add it to the map with one owner and tell the running implementers it affects.
- **Merge check.** Before merging, the **merger subagent** searches the integration branch for an existing owner of each rule, helper or fixture the ticket adds. A second owner goes back to an implementer subagent to consolidate before the merge.

Coordination is done when every entry in the map has exactly one owner on the integration branch.

## Simplification before code review

Before calling `code-review`, start a fresh reviewer subagent with no implementation conversation. It reads and follows `~/.agents/skills/simplification-review/SKILL.md` (a user-invoked skill, so pass the file rather than calling the Skill tool) against the integration branch, with the spec and tickets as requirements. Apply its supported recommendations in a single implementer subagent. Carry its exploration tasks and open decisions into the PR description or final report for the user. Then run `code-review` on the result.
