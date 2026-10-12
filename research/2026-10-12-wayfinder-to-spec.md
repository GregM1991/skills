# Wayfinder to-spec handoff investigation

Checked on 12 October 2026. The question is whether other users have seen a Wayfinder map end with a ticket that writes a spec without using Matt Pocock's `to-spec` skill.

## Finding

Yes. Upstream [issue #492](https://github.com/mattpocock/skills/issues/492) matches this failure. The current source still prevents the agent from invoking `to-spec` on its own. The public docs describe a separate, user-run spec step, but the Wayfinder skill has no explicit final handoff step. This is a workflow gap supported by a first-hand report and a second user's confirmation.

## Exact report and current status

On 9 July 2026, `gav-fyi` reported that the final local ticket, `11-assemble-spec.md`, produced a spec outside the `to-spec` template. The agent's answer said it had assembled the spec itself because it could not invoke the skill. On 12 July, `rynz` confirmed the same behavior and reported using `to-spec` manually as a workaround. The issue remains open with `bug` and `ready-for-human` labels. Its 6 October triage comment identifies the invocation restriction and leaves the design choice for human review. That comment explicitly says AI generated it. [Issue #492](https://github.com/mattpocock/skills/issues/492)

## What the current source says

The checked upstream revision is [`49dd158d1076134a641b33efb035946536778336`](https://github.com/mattpocock/skills/tree/49dd158d1076134a641b33efb035946536778336).

- `to-spec/SKILL.md` has `disable-model-invocation: true`. It starts from the current conversation and codebase context. It has no process step that requires reading every Wayfinder child ticket and resolution comment. [To-spec source](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/to-spec/SKILL.md)
- Wayfinder names a spec as one possible destination, but its default output is decisions. Its task type must unblock a decision. The five steps under "Work through the map" end with ticket and map updates. There is no final step that invokes `to-spec` or gives the user that command. [Wayfinder source](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/wayfinder/SKILL.md)
- The public Wayfinder docs describe the intended sequence as a cleared map, then `to-spec`, then `to-tickets`. The FAQ gives `/to-spec #<map_issue>` as the command that turns linked decisions into one spec. [Wayfinder docs](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/docs/engineering/wayfinder.md)

In Claude Code, `disable-model-invocation: true` prevents the agent from invoking a skill on its own and removes its description from the usual context. The user can still invoke it explicitly. Current Claude Code docs also allow explicit permission through a slash-name in the user's message. Thus, "cannot invoke automatically" is more precise than "cannot be invoked programmatically under any circumstances." Other hosts can handle this field differently. [Claude Code invocation controls](https://code.claude.com/docs/en/skills#control-who-invokes-a-skill)

Upstream also has an explicit rule against an autonomous call from one skill to another user-invoked skill. Adding an instruction to call `to-spec` automatically would conflict with that policy. [Upstream invocation policy](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/.agents/invocation.md)

My interpretation is that a destination described as "a spec" can lead the agent to create a final delivery ticket. That ticket then reaches a skill which the agent cannot invoke on its own. The intended user-run transition in the docs does not resolve that ticket's execution instructions. This interpretation matches the behavior in issue #492.

## Other public evidence

| Source | What it establishes |
| --- | --- |
| [Reddit: Wayfinder -> Spec](https://www.reddit.com/r/ClaudeCode/comments/1vlp9mz/wayfinder_spec/) | A user reports that explicitly running `to-spec` on a GitHub map omitted entire decisions across child issues. A separate review found about a dozen omissions. This is a related context-loading failure, rather than another report of a blocked automatic skill call. |
| [Whamp's wayfinder-to-spec gist](https://gist.github.com/Whamp/a6ac8d3d3ae37c433dcb0b1bab5cfc17) | A user-created handoff command checks that the map is complete, reads the map and child-ticket bodies, answers, comments, and linked assets, then follows `to-spec`. It also keeps links to the source decisions. This is a community workaround, not an upstream fix or a verified solution for every host. |
| [Issue #740: hidden user-invoked skills](https://github.com/mattpocock/skills/issues/740) | Two users report that `ask-matt` treated user-invoked skills as absent, while manual invocation worked. The issue remains open. It supports the skill-visibility problem, but does not report the exact final-ticket failure. |

The map is an index of links and short summaries. It does not contain all decision detail. Therefore, loading only the map can omit information that the spec needs. This follows from the map design and is consistent with the Reddit report. [Wayfinder map design](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/wayfinder/SKILL.md), [first-hand report](https://www.reddit.com/r/ClaudeCode/comments/1vlp9mz/wayfinder_spec/)

## Fix status and adjacent proposals

The current `to-spec` restriction and missing Wayfinder terminal step show that the exact automatic handoff remains unresolved in the checked source. Related merged PRs [#878](https://github.com/mattpocock/skills/pull/878) and [#880](https://github.com/mattpocock/skills/pull/880) changed other skill-invocation instructions. Neither changed `to-spec` invocation or added the missing Wayfinder handoff.

Fresh pages and GitHub data correct stale search snippets for these adjacent proposals:

| Proposal | Status on 12 October 2026 |
| --- | --- |
| [#823: terminal map closeout](https://github.com/mattpocock/skills/issues/823) | Closed as not planned on 6 October. Triage treated it as a gap inferred from reading the skill, without a reported failed session. |
| [#859: next-step tracker labels](https://github.com/mattpocock/skills/issues/859) | Closed as not planned on 7 October. The triage response asked for local use and a real failure report. |
| [#1006: unresolved fog after the last ticket](https://github.com/mattpocock/skills/issues/1006) | Closed as not planned on 7 October. Triage treated it as a possible terminal state, rather than an observed failed session. |

These closures do not show that issue #492 was fixed.

## Local relevance

Before the personal overlays were added, this repo's `sources.json` recorded the same upstream revision and a sync at `2026-10-11T09:43:27.628Z`. Both the vendored and installed `/home/gm/.agents/skills/to-spec/SKILL.md` contained the invocation restriction. The local Wayfinder overlay changed prototype handling and execution scope. It added no spec handoff. The vendored `to-spec/agents/openai.yaml` also had `allow_implicit_invocation: false`. These are file observations from the investigation. They do not establish which host handled a previous session or which skill copy that session loaded.

## Practical workaround

Follow the documented transition and invoke `/to-spec <map reference>` explicitly after resolving the map. Give the spec step a direct instruction to read every relevant child ticket, its resolution comments or Answer section, and linked decision assets before writing. Preserve settled decisions and check the completed spec against them. This combines the upstream docs with the community handoff approach. It is a recommendation from this investigation, not a tested fix to the user's private map. [Documented transition](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/docs/engineering/wayfinder.md), [community handoff](https://gist.github.com/Whamp/a6ac8d3d3ae37c433dcb0b1bab5cfc17)

The search covered current upstream skills and docs, GitHub issues and discussions, relevant change history, Reddit, and general web results. No additional exact failed final-ticket invocation outside issue #492 was found in the inspected results. The report and its confirmation establish other affected users. They do not establish how often the failure occurs.
