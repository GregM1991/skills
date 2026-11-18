---
name: dependency-upgrade
description: Plan, batch, and verify dependency upgrades safely. Triages outdated packages into risk tiers, upgrades in order (dev/minor/patch first, runtime majors last), verifies each batch before moving on, and produces an auditable commit sequence. Use when asked to "upgrade deps", "bump packages", "update node_modules", "fix vulnerabilities", "upgrade React/Node/TypeScript", or after `/gsd start dep-upgrade`.
---

# Dependency upgrade

Upgrade dependencies in small **batches**. Verify each batch, and give each batch its own commit. Then the history shows which upgrade caused a break.

A script does the inventory, the batch order, the install, the checks, and the commit message. You do the judgment: read changelogs, fix code for breaking changes, and decide to continue or defer.

## Set up

Set `DEP_UPGRADE` to `bun <directory of this SKILL.md>/scripts/dep-upgrade.ts`, with an absolute path. Run it from the project root. It needs Bun, git, and ripgrep, and it has no package dependencies. It finds the package manager from the lockfile: npm, pnpm, Yarn, Bun, uv, pip, Cargo, Bundler, or Go. Each command prints one JSON object. Its `next` field tells you the next step.

Before you use a manager other than npm, pnpm, Yarn classic, or Bun, read [manager notes](references/managers.md). Read them also when you change the plan file.

## 1. Make the plan

1. Run `$DEP_UPGRADE plan`. It finds outdated direct dependencies and runs the audit. It counts the files that import each package and writes the batch plan.
2. Examine `checks`. They must run the real build, the type check, the lint, and the full test suite. If a check is missing, run `plan --force` with one `--check name=command` for each check. The `--check` values replace the default checks.
3. Read the changelog or release notes for each medium-risk and high-risk package. Write down each breaking change that applies to this codebase. Treat a minor release as a possible break until its changelog shows otherwise.
4. Show the plan to the user, with the breaking changes and the audit result. Make one round of changes. To remove a package, run `$DEP_UPGRADE defer <package> --reason "<reason>"`.

The plan is complete when the user approves it.

## 2. Run the tick loop

Run `$DEP_UPGRADE tick` again and again. Each **tick** does the next step and prints one action. Do that action, then tick again.

- **`blocked`**: The working tree has changes, or the plan has no checks. Remove the cause, then tick. Ask the user before you commit or stash changes that you did not make.
- **`commit`**: All checks passed. Add changelog notes to the package lines in `messageFile` where they help. Stage all changes, run `git commit -F <messageFile>`, then tick.
- **`fix`**: A step failed. Read `failure.tail`, then the full log at `failure.log`. Read the migration guide before you change code. Then choose one:
  - The fix is small, such as a rename or a changed import. Fix the code in this batch, then tick. The tick installs and runs all checks again.
  - The fix is large, such as the removal of an API that the code uses a lot. Remove your partial fixes, run `defer` for that package, then tick. The tick restores the manifest files and applies the rest of the batch.
- **`done`**: Go to step 4.

When the install fails on peer dependencies, find the package that does not agree. Defer it, or move it into the same batch in the plan file. Keep the dependency graph correct; use no force flag.

For an app with a dev server or a CLI, start it and do a smoke test before you commit a major batch.

## 3. Handle each deferred major

1. Read the migration guide.
2. Use `rg` to find each use of the changed symbols.
3. Decide with the user: migrate now, or wait. For a large migration that is not urgent, record a follow-up task (with GSD, `/gsd start refactor`) and keep the current major.
4. To migrate now, do the work as a separate task (with GSD, its own slice). After the migration, run the checks and an end-to-end test. The test suite can miss changes in behavior.

The script does not change the language runtime (Node, Python, Rust, Ruby, Go). Do a runtime upgrade last, as its own commit, because it changes the build and run environment for all packages.

## 4. Write the summary

Use the `done` output. Write this report for the user:

```markdown
## Dependency upgrade: <date>

### Completed
- Batch 1 (dev dependency patches and minors): 12 packages, commit abc1234
- Batch 4 (react 18 → 19): commit def5678. Refactors in <files>.

### Deferred
- typescript 5.3 → 5.7: 40+ decorator uses must change. Follow-up: <link or task>.

### Still outdated on purpose
- <package>: pinned because <reason>

### Security advisories
- <advisory> resolved by <package upgrade>
- <advisory> still open: not exploitable in our usage, because <reason>
```

If the project has `.gsd/KNOWLEDGE.md`, add each upgrade gotcha that is not obvious, such as an API change or a migration step for this codebase.

The work is complete when:

- Each batch has its own commit, and each major family has its own batch.
- All checks passed after each batch.
- Each deferred package has a reason and a next step: a follow-up task, or a pin with a reason.
- Each security advisory is resolved or has a written triage.
- The user has the summary report.
