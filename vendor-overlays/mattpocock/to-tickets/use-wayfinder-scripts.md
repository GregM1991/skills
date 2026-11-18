## Publish to GitHub with the helper script

When the tracker is GitHub, the `create-tickets` command of the `wayfinder-scripts` skill replaces the manual publish in step 5. Load that skill.

1. Write the approved tickets to a plan file. Give each ticket its title, its full body from the issue template, and its blocking edges. Put `ready-for-agent` in the plan's `labels` unless told otherwise. When the source was an issue, set it as the plan's `parent`. Put the shared-owner map in `parentComment`. Use `{{key}}` or `{{key:link}}` to refer to a different ticket.
2. Omit the **Blocked by** section from each body. The script sets native blocked-by links.
3. Run `create-tickets --dry-run`, then `create-tickets`. The script publishes blockers first, makes each ticket a sub-issue of the parent, posts the parent comment, and verifies each write. It does not change the parent body.

When the command refuses (exit 2), correct the cause, or publish manually as step 5 tells.
