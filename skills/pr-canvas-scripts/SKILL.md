---
name: pr-canvas-scripts
description: Scripts that fetch a pull request, build the review page and serve it on Tailscale for the pr-review-canvas skill.
disable-model-invocation: true
---

# PR canvas scripts

This skill holds the fixed steps of the vendored `pr-review-canvas` skill. The **Scripted steps** section of that skill tells the agent when to run each command and how to use the output.

`scripts/pr-canvas.ts` has three commands. Each command prints JSON on stdout.

- `fetch <PR URL>` reads the pull request, all pages of its files and review comments, and writes `pr.json` and `patches.json`. It sorts each file into `core` or `mechanical` and gives the rule that applied.
- `build <dir>` puts the body HTML and the patches into the canvas template and writes `review.html`. It fails when the body names a diff key that `patches.json` does not have.
- `serve <file>` serves one file on the Tailscale IPv4 address only, checks it through that address, and stops after a time limit.

Run `bun scripts/pr-canvas.ts --help` for options and exit codes. Run `bun test` in this directory to test the script.
