# Skills repository rebuild plan

| Field | Value |
| --- | --- |
| Status | Complete. All 10 steps done. |
| Plan owner file | `/home/greg/workspace/skills/REBUILD-PLAN.md` |
| Target repo | `GregM1991/skills`, checkout `/home/greg/workspace/skills` |
| Second repo | `GregM1991/gm-pi-environment`, checkout `/home/greg/workspace/pi-environment` |
| Last updated | 2026-08-24 |
| Implementation started | yes |

## Resume instructions for a new agent session

1. Read this whole file before doing anything. All research is recorded here; do not redo it.
2. Check the step table under "Execution steps". Work the first step whose status is `todo`.
3. Update that step's status and append a line to "Session log" when you finish it.
4. Do not commit in either repository without explicit user approval for that commit.
5. Locked decisions are not open for redesign. If evidence contradicts one, stop and ask.

## Problem this solves

Skills were arriving on this machine through three uncoordinated paths: the `skills` CLI writing
to `~/.agents/skills`, the `gm-pi-environment` Pi package shipping its own `skills/` directory,
and an abandoned `GregM1991/skills` repo with two-way copy scripts. 78 distinct skills existed
across those locations with 13 conflicting copies. Pi resolves name collisions by keeping the
first skill found, so duplicates were being silently shadowed.

## Locked decisions

1. `GregM1991/skills` is the single canonical source for all skills on all machines.
2. Rebuild it in place. `git rm -r` the current tree and commit the new structure. History keeps
   the old 47 skills. No force-push, no repo deletion.
3. Scope: the 28 skills currently in `gm-pi-environment/skills`, plus all skills under Matt Pocock's four included categories. Nothing else. The 20 skills that exist only in the old repo are dropped. The current Matt count is 36 and can change on future syncs.
4. Third-party skills are vendored into the repo by an automated nightly sync that commits
   straight to `main`. No review gate, no PR.
5. `gm-pi-environment` stops shipping general-purpose skills and drops `./skills` from
   `pi.skills`. Pi receives skills like every other harness, through `~/.agents/skills`.
6. Matt subset: all skills under `engineering`, `in-progress`, `misc`, and `productivity`, excluding `deprecated`. The current count is 36 and can change on future syncs.
7. Local modifications in vendored skills are overwritten by upstream. This applies to
   `btca-cli`, `core-web-vitals`, `find-skills`, `pr-review-canvas`, `unslop`, `youtube-content`,
   and `agent-browser`.
8. `write-pr` and `writing-style` carry over exactly as they are on disk, including uncommitted
   edits. Those edits are wanted.
9. `agent-browser` is vendored with a two-path merge, not kept as authored.

## Why this shape works, with the mechanics that constrain it

Facts verified against `skills` CLI v1.5.23 (`npm pack skills@1.5.23`, read `dist/cli.mjs`):

- Canonical global store is `~/.agents/skills/<name>`. Per-harness directories get symlinks
  into it. `~/.pi/agent/skills/<name>` is one such symlink.
- The CLI supports about 70 harnesses, including a `universal` adapter on `.agents/skills`.
- The lock file is `~/.agents/.skill-lock.json`, schema version 3.
- `skills update` clones each source into a temp dir or reads the GitHub tree API, compares
  folder hashes against the lock, then re-runs `skills add <src> --skill <name> -g -y` for
  changed skills. It never writes to a user's own checkout of a source.
- `skills update` accepts only `-g`, `-p`, `-y`. There is no `--dry-run`.
- Discovery (`discoverSkills`, cli.mjs:1206) walks a priority list: repo root at max depth 1,
  and `skills/`, `skills/.curated`, `skills/.experimental`, `skills/.system` plus agent project
  dirs at max depth 3. The walk stops descending a branch once it finds a `SKILL.md`.
  A fallback at max depth 5 runs only when nothing was found or `--full-depth` is passed.
- Consequence: skills at repo root cannot host a `vendor/` tree, because root is depth 1.
  Under `skills/`, three levels work, so `skills/vendor/<owner>/<name>/` is the deepest safe
  layout. Anything at four levels needs `--full-depth`.
- Name collisions inside one source are resolved by a `seenNames` set: first found wins, the
  loser is dropped silently.
- Git submodules cannot be used for indirection. `cloneRepo` runs `--depth 1` with no
  `--recurse-submodules`, and the tree API path filters `type === "blob"`, so gitlinks vanish.
- A `.well-known/agent-skills` index cannot be used either. Entries need a pinned
  `sha256` digest per skill and multi-file skills need a hosted archive, so it needs the same
  refresh job as vendoring while holding no content.

## Target layout

```
GregM1991/skills
├── skills/
│   ├── <authored-skill>/SKILL.md              depth 1
│   └── vendor/
│       └── <upstream-owner>/<name>/SKILL.md   depth 3, the discovery limit
├── sources.json
├── scripts/sync-upstream.ts
└── .github/workflows/sync.yml
```

The sync must flatten upstream category directories. Matt's upstream layout is
`skills/<category>/<name>`, which would land at `skills/vendor/mattpocock/<category>/<name>`,
depth 4, and fall out of the priority walk.

## Install and update flow

```bash
# new machine
npx skills add GregM1991/skills --all -g

# ongoing, on any machine
npx skills update
```

## Contents of the new repo: 64 skills at the current upstream baseline

The total can change when a future sync adds or removes skills in Matt's four included categories.

### Vendored, 12 from the current pi-environment set

| Skill | Upstream repo | Path in upstream | Local copy vs upstream |
| --- | --- | --- | --- |
| accessibility | addyosmani/web-quality-skills | `skills/accessibility` | stale, upstream added `references/A11Y-PATTERNS.md` |
| agent-browser | vercel-labs/agent-browser | two-path merge, see below | stale snapshot |
| anki-connect | intellectronica/agent-skills | `skills/anki-connect` | identical |
| btca-cli | davis7dotsh/better-context | `skills/btca-cli` | `SKILL.md` differs |
| core-web-vitals | addyosmani/web-quality-skills | `skills/core-web-vitals` | `SKILL.md` differs |
| fallow | fallow-rs/fallow-skills | `fallow/skills/fallow` | stale, upstream added `agents/`, `references/mcp.md`, `references/node-bindings.md` |
| find-skills | vercel-labs/skills | `skills/find-skills` | `SKILL.md` differs |
| impeccable | pbakaus/impeccable | `.agents/skills/impeccable` | upstream moved the generated universal skill tree |
| pr-review-canvas | cursor/plugins | `cursor-team-kit/skills/pr-review-canvas` | `SKILL.md` differs |
| unslop | poteto/plugins | `pstack/skills/unslop` | upstream overwrites the locally adapted frontmatter by user approval |
| security-review | getsentry/skills | `skills/security-review` | identical |
| youtube-content | NousResearch/hermes-agent | `skills/media/youtube-content` | stale and locally modified |

`agent-browser` two-path merge: `SKILL.md` comes from `skills/agent-browser/`, while
`references/` and `templates/` come from `skill-data/core/`. Evidence that this is the correct
mapping: template filenames match exactly and `references/profiling.md` is byte-identical.
Upstream has since added `references/streaming.md`, `trust-boundaries.md`, and `webgpu.md`.

`youtube-content` self-declares its origin in frontmatter: `source-repository:
https://github.com/NousResearch/hermes-agent`, `source-commit: 861d69c7`.

The 12 explicit vendored skills come from 11 repo source objects. The Matt category source is the twelfth source object.

### Vendored, all 36 current Matt Pocock skills

Source `mattpocock/skills`, categories `engineering`, `in-progress`, `misc`, `productivity`,
excluding `deprecated`. Flatten the category level on sync. This source contract is dynamic, so the Matt count and total can change on future syncs.

```
engineering:   ask-matt code-review codebase-design diagnosing-bugs domain-modeling
               grill-with-docs implement improve-codebase-architecture prototype research
               resolving-merge-conflicts setup-matt-pocock-skills tdd to-spec to-tickets
               triage wayfinder wizard
in-progress:   claude-handoff implement-spec loop-me setup-ts-deep-modules writing-beats
               writing-fragments writing-shape
misc:          git-guardrails-claude-code migrate-to-shoehorn scaffold-exercises
               setup-pre-commit
productivity:  grill-me grilling handoff teach to-questionnaire wait-what writing-for-agents
```

Collision check already done at the current baseline: none of these 36 names collide with the other 28 skills.

### Authored, 16

`anki-card-standards`, `build-react-codebase-guidelines`, `capture-agent-browser-auth-state`,
`caveman`, `code-optimizer`, `dependency-upgrade`, `improve-frontend-architecture`,
`observability`, `onepassword-agent-secret-flows`, `podcraft-episode-creation`,
`react-performance-guidelines`, `review-react-codebase-red-flags`, `testing-philosophy`,
`write-pr`, `writing-style`, `zoom-out`

Notes:
- `caveman` was traced and has no upstream match. `JuliusBrussee/caveman` differs by 81 lines,
  `amanattar/caveman-claude-skill` by 62.
- `improve-frontend-architecture` is byte-identical to the old repo copy, which is being wiped,
  so it becomes authored here.
- `observability` and `dependency-upgrade` are de-GSD'd forks per the old `MANIFEST.md`.
- `code-optimizer` is marked personal/local in the old `MANIFEST.md`.
- `write-pr` is currently untracked and `writing-style` is currently modified in
  `gm-pi-environment`. Copy the on-disk state, not `HEAD`.

## Matt double-load problem, to fix during step 8

Three Matt sets exist today: 36 upstream, 35 vendored in the Pi extension at pinned ref
`8b78b53`, and 14 installed globally by the CLI.

Before step 8, both the extension vendor and the CLI copies were live in Pi at the same time. In one observed session, 14 Matt skills resolved from `~/.pi/agent/skills` and 5 resolved from the extension vendor: `code-review`, `research`, `resolving-merge-conflicts`, `wizard`, `writing-for-agents`. Pi keeps the first found, so for names in both, the unpinned CLI copy beat the pinned vendor.

The extension itself routes by absolute path into
`extensions/matt-workflow-pi-extension/vendor/mattpocock-skills`. The duplicate ambient entries came from the extension's `resources_discover` handler registering the `engineering` and `productivity` vendor category paths. Step 8 removed those category registrations and kept only the `matt-workflow` router ambient; the pinned vendor remains private extension data for absolute routing.

## Execution steps

| # | Step | Status |
| --- | --- | --- |
| 1 | Resolve dirty trees: `gm-pi-environment` has `skills/writing-style/SKILL.md` modified and `skills/write-pr/` untracked; `workspace/skills` has `build-react-codebase-guidelines/SKILL.md` modified | done |
| 2 | In `GregM1991/skills`, `git rm -r` the current tree, keeping history | done |
| 3 | Create `skills/` and move the 16 authored skills in, from the on-disk pi-environment state | done |
| 4 | Write `sources.json`: 12 explicit vendored skills across 11 repo sources plus the Matt source, with the `agent-browser` two-path merge case | done |
| 5 | Write `scripts/sync-upstream.ts`, starting from `gm-pi-environment/extensions/matt-workflow-pi-extension/scripts/sync-matt-skills.ts` | done |
| 6 | Add `.github/workflows/sync.yml`, nightly, auto-commit to `main`, fails loudly | done |
| 7 | Delete `install-to-pi.ts` and `sync-from-pi.ts`; assess `audit-skills.ts` (334 lines) for reuse as a freshness check | done |
| 8 | In `gm-pi-environment`: delete `skills/`, drop `./skills` from `pi.skills`, stop the Matt vendor being surfaced as ambient skills, update `AGENTS.md` which currently names that repo canonical for skills | done |
| 9 | Per-machine cleanup: `npx skills remove` the unwanted globals, then `npx skills add GregM1991/skills --all -g` | done |
| 10 | Prune stale `~/.agents/.skill-lock.json` entries | done |

### Step 5 detail

`sync-matt-skills.ts` is 133 lines and already does clone-at-ref, byte-level tree diff,
added/removed/changed reporting, pinned `SOURCE.json` output, and `--dry-run`. It needs:

- multiple sources driven by `sources.json`
- category flattening so nothing lands at depth 4
- a name-collision guard that fails the run
- the `agent-browser` two-path merge case
- upstream deletion handling, so the repo does not accumulate zombies
- a `lastSyncedAt` per source, so a broken job is visible

Do not inject provenance headers into vendored `SKILL.md` files. The diff is byte-level, so an
injected line would mark every skill changed on every run.

Declare licence paths once at repo source level, and copy each declared upstream licence into every vendored folder from that source.

### Step 10 detail

Before step 9, `~/.agents/.skill-lock.json` tracked seven skills that did not exist in
`~/.agents/skills`: `anki-connect`, `btca-cli`, `pr-review-canvas`, `todoist-api`,
`web-design-guidelines`, `improve-frontend-architecture`, and `react-performance-guidelines`.
Step 9 restored five as canonical skills. After step 9, only `todoist-api` and
`web-design-guidelines` remained stale.

## Verification

```bash
# discovery finds every expected skill from the new repo, without --full-depth
npx skills add /home/greg/workspace/skills --list

# current baseline: 64 = 16 authored + 12 explicit vendored + 36 current Matt
# the Matt and total counts can change on future syncs
# no duplicate names in the listing

# after step 8, Pi must show no duplicate skill names
# and the four former collisions must resolve from one path only:
#   build-react-codebase-guidelines, fallow, find-skills, review-react-codebase-red-flags

# sync script dry run must be clean immediately after a sync
bun scripts/sync-upstream.ts --dry-run
```

## Things deliberately not done

- No review gate on upstream changes. The nightly job commits directly to `main`.
- No vendoring of the 20 skills that exist only in the old `GregM1991/skills` tree. They stay in
  git history and are recoverable with `git show`.
- The Matt vendor inside the Pi extension stays pinned and is not replaced by the new repo.

## Session log

| Date | Session | What happened |
| --- | --- | --- |
| 2026-08-21 | design | Investigated `npx skills update` behavior, mapped the three-way skill split, traced provenance for all 27 pi-environment skills, locked the 9 decisions above, wrote this plan. No repository changed. |
| 2026-08-21 | step-1 | Verified both dirty trees, backed up all uncommitted content to `/home/greg/workspace/skills-rebuild-backup/` with a sha256 manifest, confirmed `skills/write-pr/` is the deleted `prompts/write-pr.md` migrated into skill form, and compared `build-react-codebase-guidelines/SKILL.md` across repos. Nothing staged or committed. |
| 2026-08-21 | step-2 | Verified backup and pushed HEAD, then ran `git rm -rf .` in `GregM1991/skills`, staging deletion of all 362 tracked files (44 skill directories plus support files); `REBUILD-PLAN.md` survives untracked, nothing committed. |
| 2026-08-21 | step-3 | Copied the 16 authored skills from the on-disk `gm-pi-environment` state into `skills/<name>/`, merged `build-react-codebase-guidelines/SKILL.md` per the step-1 decision, and staged the additions with `git add`; nothing committed. |
| 2026-08-21 | step-4 | Wrote the initial `sources.json` at the repo root for 11 upstream skills (addyosmani's repo yields 2) plus one Matt category-mode source, using explicit from/to path pairs per skill, `ref: "HEAD"` to track each default branch, and null `lastSyncedAt`/`resolvedCommit` placeholders for the sync script to fill; verified valid JSON and no name collisions across all 62 skills; nothing staged or committed. |
| 2026-08-21 | step-5 | Wrote `scripts/sync-upstream.ts` (Bun, zero dependencies) covering multi-source sync, category flattening, a three-way collision guard, the agent-browser two-path merge, upstream deletion sweeping, and per-source `lastSyncedAt`; fixed three wrong `licensePaths` values in `sources.json` found during verification and lowercased the vendor owner directory for `NousResearch` in the script only; verified with a real `--dry-run` (46 vendored skills planned, exit 0, no repo writes), an isolated collision-guard run against a duplicated copy of `sources.json`, and an isolated depth-4 assertion test; nothing staged or committed. |
| 2026-08-23 | step-6 | Added `.github/workflows/sync.yml` with a daily 03:00 UTC and manual trigger, non-overlapping three-attempt whole-sync retries, scoped generated-output commits, and safe pull/rebase before a direct non-force push to `main`; validated YAML and embedded shell syntax; nothing staged or committed. |
| 2026-08-23 | step-7 | Retired `audit-skills.ts` because its old manifest, lock, flat-layout, exclusion, audit-age, runtime-metadata, and partial upstream checks are obsolete or duplicate `sync-upstream.ts --dry-run`; all three legacy scripts remain absent. |
| 2026-08-24 | unslop-amendment | Added `unslop` as the twelfth explicit vendored skill, generated the initial vendor tree, and accepted upstream frontmatter as canonical. The source provenance was corrected to `poteto/plugins` in the `unslop-source-correction` session below. Current upstream also added Matt's `implement-spec` and moved Impeccable's generated universal tree, so the approved dynamic baseline is 64 = 16 authored + 12 explicit vendored + 36 Matt. Real sync and clean dry run passed; list-only discovery found 64 unique skills. |
| 2026-08-24 | step-8 | Removed the full environment `skills/` tree and root `./skills` resource, limited Matt ambient discovery to the `matt-workflow` router, kept all 35 pinned extension vendor skills private and available for absolute routing, moved five non-Matt default routes to `~/.agents/skills`, updated source-of-truth documentation and bootstrap guidance, and removed the obsolete global-store-emptying helper. Extension checks, 136 tests, shell syntax, JSON parsing, diff checks, and focused discovery and route validation passed; nothing staged or committed. |
| 2026-08-24 | unslop-source-correction | The user corrected `unslop` provenance from `cursor/plugins:pstack/skills/unslop` to authoritative `poteto/plugins:pstack/skills/unslop`. Split `unslop` into its own repo source with `pstack/LICENSE`, removed the unused per-skill licence schema, and regenerated the vendor tree. Real sync removed the Cursor zombie and created the Poteto destination; clean dry run, byte checks, type checks, and list-only discovery of 64 unique skills passed. Nothing staged or committed. |
| 2026-08-24 | step-9 | Proved remote `origin/main` at `75766fc` contains 64 unique canonical skills and corrected `sources.json`, saved and verified the pre-mutation backup at `/home/greg/workspace/skills-rebuild-backup/step-9/`, removed 16 proved CLI-managed unwanted globals, and installed all 64 canonical skills from `GregM1991/skills`. Disk, CLI, Pi links, tracked-file byte checks, and representative multi-file checks passed. The lock has two stale names, `todoist-api` and `web-design-guidelines`, for step 10. Nothing staged or committed. |
| 2026-08-24 | step-10 | Saved and verified the pre-mutation backup at `/home/greg/workspace/skills-rebuild-backup/step-10/`, then used skills CLI v1.5.23 to remove the stale lock keys `todoist-api` and `web-design-guidelines` and the matching broken Claude links. The lock, 64-skill global store, CLI listing, Pi and Claude links, all bounded CLI harness paths, representative skills, backup manifest, and repository state checks passed. Nothing staged or committed. |
