## Triage scripts

On a GitHub tracker, load the `triage-scripts` skill before you start. Its scripts replace these manual steps above:

- **Show what needs attention**: run its `queue` command. Do not query the tracker by hand. Show `conflicts` first.
- **Triage a specific issue or PR**, step 1: if the `github-issue-reader` skill is installed, use it to read the issue and its comments.
- **Triage a specific issue or PR**, step 5: write the comment to a file and run its `apply` command. Do not change labels, post, or close by hand.
- **Quick state override**: run `apply --dry-run`, show the plan, and run `apply` after the maintainer confirms.

The rules above about which outcome to choose and what each comment must contain still apply. If the tracker is not GitHub, or the scripts cannot run, do these steps by hand.
