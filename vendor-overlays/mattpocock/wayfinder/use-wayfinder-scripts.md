## Helper scripts on GitHub

When the tracker is GitHub with native sub-issues and issue dependencies, load the `wayfinder-scripts` skill. Its commands replace these manual tracker steps. They read, write, and verify the tracker, and print JSON. You keep the judgment: the questions, the answers, the gists, the fog, and the scope.

- **Chart the map**, step 4 (create the tickets, then wire them in a second pass): write the tickets, their labels, and their blocking edges to a plan file. Use `{{key}}` or `{{key:link}}` for cross-references. Then run `create-tickets`. It creates the child tickets with blockers first, wires the edges, and writes the real ids.
- **Work through the map**, step 1 (load the map): read the map body, then run `frontier` to find the open, unblocked, unclaimed tickets in map order.
- Step 2 (choose and claim): when the user names no ticket, take `first` from `frontier`. Run `claim` before any work.
- Step 4 (record the resolution): write the answer to a file. Run `resolve` with a one-line gist. It posts the resolution comment, closes the ticket, and adds the context pointer to Decisions so far.
- Step 5 (new tickets and scope): add new tickets with `create-tickets`. Rule a ticket out of scope with `resolve --out-of-scope`.

When a command refuses (exit 2), or the tracker is not GitHub, do that step manually as this skill tells.
