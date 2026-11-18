---
name: code-review-prep
description: Script that pins the fixed point and collects commits, issue references, spec candidates and merge-base standards for the code-review skill.
disable-model-invocation: true
---

# Code review prep

This skill holds the fixed preparation steps of the vendored `code-review` skill. The **Scripted preparation** section of that skill tells the agent when to run the script and how to use the output.

`scripts/review-prep.ts <fixed-point>` runs only read-only git commands in the current repository. It prints JSON on stdout and writes `prep.json` and the merge-base copies of the standards files to a new temporary directory, or to `--out <dir>`.

Run `bun scripts/review-prep.ts --help` for options and exit codes. Run `bun test` in this directory to test the script.
