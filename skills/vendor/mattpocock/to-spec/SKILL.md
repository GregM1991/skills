---
name: to-spec
description: "Write and publish a specification from a settled conversation or a completed Wayfinder map. Use when a Wayfinder destination requires a spec or settled decisions need a specification."
---

This skill takes the current conversation context or resolved Wayfinder decisions and codebase understanding and produces a spec. Do NOT interview the user; synthesize the settled decisions.

The issue tracker and triage label vocabulary should have been provided to you. If not, tell the user to run `/setup-matt-pocock-skills`.

## Wayfinder input

When the source is a Wayfinder map, complete these steps before the Process below:

1. Read the full map, query all its child tickets, and read every ticket linked from **Decisions so far** and **Out of scope**. Read each child or linked ticket's full body, resolution comments or Answer section, and linked decision assets. The map's summaries alone are not sufficient source material.
2. Confirm that every on-route decision ticket is resolved and **Not yet specified** contains no unresolved in-scope fog. A final specification handoff ticket may remain open until this skill publishes the specification. If decisions remain open or conflict, report them and stop before drafting.
3. Preserve the settled decisions and scope in the specification. Cite the map and its source tickets under **Further Notes** so readers can recover the decision detail.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the spec, and respect any ADRs in the area you're touching.

2. Sketch out the seams at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase, the better - the ideal number is one.

Check with the user that these seams match their expectations.

3. Write the spec using the template below, then publish it to the project issue tracker. Apply the `ready-for-agent` triage label - no need for additional triage.

<spec-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

This list of user stories should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts, not a working demo, just the important bits.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this spec.

## Further Notes

Any further notes about the feature.

</spec-template>
