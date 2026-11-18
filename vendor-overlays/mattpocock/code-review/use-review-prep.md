## Scripted preparation

Use the `review-prep` script for the fixed work of steps 1 to 3. These instructions replace the parts of the process above that follow:

- The `git rev-parse`, diff and `git log` commands in **1. Pin the fixed point**.
- The search for issue references (item 1) and spec files (item 3) in **2. Identify the spec source**.
- The file search in **3. Identify the standards sources**.
- The `git show <merge-base>:<path>` reads in **Standards sources and fixes**.

The judgment stays with you: which issue or file is the spec, which standards apply, and both review passes.

The script is `code-review-prep/scripts/review-prep.ts` in the parent directory of this skill's directory. Set `REVIEW_PREP` to its absolute path. The script needs Bun and git. Run it from the repository under review:

```bash
bun "$REVIEW_PREP" <fixed-point>
```

Exit code 1 means a bad ref, an empty diff or a git failure: show the error to the user and stop. Exit code 2 is a usage error.

Use the JSON output as follows:

- `diffCommand` pins both ends by SHA. Give it and `commits` to both sub-agents. When `uncommittedFiles` is more than 0, tell the user that the review excludes uncommitted changes.
- `issueRefs` lists the references in the commit messages and the numbers in the branch name (`kind: "number"`). A `closing` reference is the strongest spec candidate. Fetch the candidates with the tracker workflow and decide which one is the spec.
- `specCandidates` ranks the files under `docs/`, `doc/`, `specs/`, `spec/` and `.scratch/` by branch words, issue numbers and changes in the diff. A score of 0 shows no match. Read the top candidates before you decide.
- `standards` lists the standards files at the merge-base. Each `snapshot` is the merge-base copy of the file: give these paths to the Standards sub-agent as its standards sources. A nested instruction file shows only when the diff changes files in its `scope`. An entry with `symlinkTo` points to another file. Add each standards document that the script did not find.
- `standardsAddedInDiff` lists the standards files that the diff adds. They are part of the change under review, not an authority.
- When a list has an `omitted` count above 0, read the full list in `prepJson`.
