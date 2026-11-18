## Scripted steps

Use the `pr-canvas` script for the fixed steps. These instructions replace the parts of the workflow above that follow:

- The three `gh api` calls in **1. Fetch PR data**.
- The `jq` and Python commands in **3. Available CSS classes and JS utilities**.
- All of **4. Assemble and serve**, which includes the server on 127.0.0.1 and the in-app browser.

The judgment stays with you: the explanation, the final core and mechanical split, the annotations, the pseudocode and the page structure from **2. Analyze the PR and write the body HTML**.

The script is `pr-canvas-scripts/scripts/pr-canvas.ts` in the parent directory of this skill's directory. Set `PR_CANVAS` to its absolute path. The script needs Bun and an authenticated `gh` CLI. Exit code 1 is a failure that the script describes on stderr. Exit code 2 is a usage error.

1. Fetch the PR:

   ```bash
   bun "$PR_CANVAS" fetch <PR URL>
   ```

   The script reads all pages of files and review comments. It writes `pr.json` (metadata, review comments and files) and `patches.json` (patch text for each `diffKey`) to the `dir` that it prints. If `filesTruncated` is true, tell the user that GitHub returned only part of the file list.
2. Read `pr.json` and `patches.json`. Each file has a `category` (`core` or `mechanical`) and the `reason` for it, and core files come first. The category is a first sort by fixed rules: lockfiles, generated files, renames without content change, and files without a text patch are `mechanical`. Move a file to the other group when this PR needs it, for example a generated file that the author edited by hand.
3. Write the body HTML to `<dir>/body.html`. Put `<div data-diff="<diffKey>"></div>` where a diff must show, with the `diffKey` values from `pr.json`.
4. Build the page:

   ```bash
   bun "$PR_CANVAS" build <dir>
   ```

   The script puts `styles.css`, `renderer.js`, the body and the script-safe patch JSON into `template.html` and writes `<dir>/review.html`. When the body uses a `data-diff` key that `patches.json` does not have, the build fails and names the key. Correct the key and build again. `diffsNotShown` lists the patches that the page does not show. Make sure that you left out each one on purpose.
5. Serve the page:

   ```bash
   bun "$PR_CANVAS" serve <dir>/review.html
   ```

   The server binds only to the Tailscale IPv4 address of this machine, so only the tailnet can reach it. The script checks the page through that address before it returns. The server stops after 240 minutes; `--ttl <minutes>` changes this. Give the user the `url`, the `expiresAtLocal` time and the `stopCommand` from the output.
