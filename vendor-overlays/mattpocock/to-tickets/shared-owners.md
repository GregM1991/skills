## Shared owners

Vertical slices each cut through every layer, so tickets built in parallel rebuild the same rule unless one ticket owns it. Before you quiz the user, build a **shared-owner map**:

1. Search the codebase for every rule, helper, constant, schema, fixture or test harness that two or more draft tickets need: a permission check, a sort order, a validity predicate, a private-file write, a browser test helper. Acceptance criteria repeated across tickets (the same test matrix, device or theme checks) count too.
2. Give each one a single owner: an existing symbol (name it and its module), or a **foundation ticket** that builds it and blocks every ticket that uses it. Repeated acceptance criteria get stated once, in their owner ticket, and referenced from the others.
3. Show the map beside the breakdown when you quiz the user.

The map is complete when every shared item has exactly one owner.

When publishing:

- Each ticket gets a **Shared owners** section naming the owners it must use, and a **Skills** section naming the repository's own skills (for example under `.agents/skills/` or `.claude/skills/`) whose descriptions match the ticket's work.
- Add the full map as a comment on the parent issue, leaving its body untouched. With local files, write it to `.scratch/<feature-slug>/shared-owners.md`.
