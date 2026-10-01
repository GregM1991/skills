---
name: simplification-review
description: Review a change in fresh context for a smaller design that still meets the spec.
disable-model-invocation: true
---

# Simplification review

Find unnecessary scope, repeated domain logic, avoidable state, and duplicate tests. Recommend concrete changes that reduce the effort needed to understand and maintain the code.

Prioritize simplicity and elegance while preserving required behavior.

Produce a review. Make code changes only when the user also requests them.

## 1. Establish fresh context

Use a reviewer session that did not implement the change.

If the current session participated in implementation, start a reviewer with no inherited conversation. Give it:

- This skill.
- The repository path and review target.
- The spec, accepted requirements, and user constraints.
- Pointers to applicable repository instructions and domain documentation.

Let the reviewer form its assessment from those sources and the code.

If a fresh session cannot be started, provide a ready-to-use review prompt and state that the independent review is pending.

This step is complete when the reviewer has the required inputs without the implementation conversation.

## 2. Establish repository context and the review boundary

Read the spec and resolve the comparison base, target commit, and any uncommitted changes included in the request.

Read applicable agent-facing documentation in full:

- Root `AGENTS.md` and `CLAUDE.md`.
- Instructions in ancestor directories and subdirectories that govern changed files.
- Instructions governing affected callers or locations proposed for moved code.
- Relevant `CONTEXT.md` files and documents referenced by those instructions.

Use the repository's domain terms. Adopt its documented conventions as the starting point for the review. Identify compatibility, migration, security, and operational constraints that explain apparent complexity.

Evaluate the conventions themselves when they contribute to complexity. A useful simplification may require an exception, a revised convention, or work beyond the documented approach.

For each such suggestion, cite the relevant instruction and flag the departure. Explain why the alternative is simpler, what behavior it preserves, and its tradeoffs. Present the recommendation for the developer to decide. Keep the recommendation distinct from authorization to change the code or documentation.

Map the changed files to requirements and implementation areas. Record missing requirements as uncertainty. Confirm a change is unnecessary before proposing its removal.

This step is complete when every changed area is accounted for, applicable documentation has been read, and the behavior to preserve is explicit.

## 3. Examine the design

Read the changed code and enough surrounding code to verify each candidate finding.

Check each area through these questions:

| Area | Questions |
| --- | --- |
| Scope | Which changes are required by the spec? Which can leave this change without breaking acceptance criteria or a required dependency? |
| Domain logic | Where does the same rule have multiple owners? Can one existing operation own validation, transitions, or persistence? |
| State | Which values can be derived? Which state copies require synchronization? Can the model represent fewer invalid combinations? |
| Tests | What behavior and failure boundary does each test protect? Which tests repeat that protection without adding a distinct case? |

Also inspect helpers, wrappers, and configuration introduced by the change. Check whether they reduce caller complexity or distribute one operation across more places.

For shared logic, verify that the callers follow the same domain rule. For test removal, identify the coverage that remains.

Distinguish complexity introduced by the change from existing complexity it merely touches.

This step is complete when each changed area has been checked or recorded as unreviewed with a reason.

## 4. Verify the proposed simplifications

For each candidate:

- Cite the concrete code locations and current behavior.
- Describe the smaller design, including what is removed and what owns the remaining behavior.
- Trace the proposal against the acceptance criteria and relevant callers.
- Explain the reduction in rules, state, dependencies, or coordination.
- Identify the checks needed to confirm behavior is preserved.
- State migration costs, tradeoffs, and unresolved assumptions.

Retain findings whose benefit exceeds the complexity of making and maintaining the change. Prefer an existing operation when it already owns the required behavior.

Treat line counts as supporting evidence. Preserve required validation, compatibility, and distinct test coverage.

## 5. Return the review

Start with whether the change has material simplification opportunities.

Rank findings by expected benefit and change risk. For each finding, include:

- Location and evidence.
- Proposed design.
- Required behavior preserved.
- Benefit and tradeoff.
- Validation needed.
- Any departure from repository guidance, with the source instruction, reason for the departure, and decision needed from the developer.

State the reviewed base and target, coverage gaps, and which claims were verified from code or execution.

If no material simplification is justified, say so. A review can finish with no findings.
