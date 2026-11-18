# Manager notes

Run `$DEP_UPGRADE --help` for all options.

## Rules that the script applies

- **Direct packages only.** The script plans only packages that the manifest declares. For uv, pip, and Go, it counts outdated transitive packages in `transitiveOutdated`.
- **Skips.** It skips a prerelease, a version that is not newer, and a range that it cannot rewrite, such as `workspace:*`, a git URL, or `>=1 <3`. Each skip has a reason in `skipped`.
- **Bump kind.** Under 1.0.0, a minor change counts as major.
- **Risk.** Low: a dev patch or minor, or a runtime patch. Medium: a runtime minor, or a dev major. High: a runtime major, a framework major, or any TypeScript change that is not a patch.
- **Batch order.** 1: dev patches and minors. 2: runtime patches. 3: runtime minors. 4 and more: each major family alone, low risk first, frameworks last. A family is a package with its `@types/` package and its scope. For example, `react-router` and `@react-router/dev` move together, and `react-dom` moves with `react`.
- **Manifest edits.** The script keeps the range operator and the precision, for example `^1.2.3` to `^2.0.1` and `~> 7.0` to `~> 8.0`.
- **Checks.** Each check runs with `CI=true`, so a test runner in watch mode exits. The time limit is 30 minutes for each check (`--timeout-minutes`).

## State file

`plan` writes `<git dir>/dep-upgrade/state.json`, with logs in `logs/` beside it. Use `--state-dir` to put it in a different folder. Run `$DEP_UPGRADE status` to see the plan and the progress.

To change the plan, edit `batches` in the state file. Edit only batches that have the status `pending` or `failed`. Keep each `id` unique. Give a new batch `"status": "pending"`. Copy the fields of a package or a batch from an entry that is already in the file.

When a package leaves a batch that the script applied, the next tick runs `git checkout <base commit> -- <manifest files>` and then a sync install. This removes each manual edit that you made to those files during the fix.

## Managers

- **npm, pnpm, Yarn classic, Bun.** Only the root `package.json`. The script does not plan workspace packages one by one. After the install, it compares each version in `node_modules` with the target version. The audit uses the manager's own audit command.
- **Yarn Berry.** It has no `outdated` command, so `plan` stops. Find outdated packages by hand, or use `--manager npm` when `node_modules` exists.
- **uv.** Uses `uv pip list --outdated` and `uv add`, with `--group` or `--optional` for the original group. The script does not run an audit. Run `pip-audit` by hand if the user wants one.
- **pip.** Uses `pip list --outdated`, with `.venv/bin/python` when it exists. It rewrites pinned lines in `requirements*.txt` and installs each changed file. A package without a pin gets `pip install name==version`, which changes no file. Add such packages to a requirements file first. No audit.
- **Cargo.** Needs `cargo-outdated`. Rewrites the version in `Cargo.toml` and runs `cargo update -p`. It does not rewrite a `workspace = true` dependency. Default checks: `cargo build --all-targets` and `cargo test`. Add `cargo clippy` with `--check` when the project uses it. No audit.
- **Bundler.** Uses `bundle outdated --only-explicit`. Rewrites the Gemfile constraint and runs `bundle update <gems>`. No audit; run `bundle-audit` by hand.
- **Go.** Uses `go list -m -u` and `go get`, then `go mod tidy`. Go has no dev type. A Go major uses a new module path, such as `/v2`, so the list does not show it. Find majors by hand. Pseudo-versions count as prereleases. No audit; run `govulncheck` by hand.
