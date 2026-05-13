# Skills Repository Migration Plan

## Goal

Make this repository the canonical source of truth for personal/user-managed agent skills, installed into Pi via:

```text
/home/gm/.agents/skills
```

The repository should contain portable skill definitions only. Runtime policy such as whether Pi should auto-advertise a skill belongs to the consuming system/install step, not to the checked-in skill itself.

## Non-goals

- Do not move skills yet.
- Do not include package-only skills that arrive solely because a Pi package/extension is installed.
- Do not preserve `disable-model-invocation` in repo copies.
- Do not split canonical skills into separate top-level categories such as `personal/`, `routers/`, `matt/`, or `specialists/`.

## Path note

The requested path `/home/jam/workspace/skills` does not exist on this machine. The existing skills repository is:

```text
/home/gm/workspace/skills
```

## Current repository state

Current repository shape:

```text
/home/gm/workspace/skills
├── README.md
├── anki-card-standards/
├── anki-connect/
├── build-react-codebase-guidelines/
├── improve-frontend-architecture/
├── review-react-codebase-red-flags/
└── testing-philosophy/
```

Current git status at inspection time:

```text
## main...origin/main
```

## Desired repository shape

Use a flat directory layout matching Pi's install target:

```text
/home/gm/workspace/skills
├── README.md
├── MIGRATION-PLAN.md
├── MANIFEST.md
├── skills.lock.json
├── scripts/
│   ├── audit-skills.ts
│   ├── install-to-pi.ts
│   └── sync-from-pi.ts
├── accessibility/
├── agent-browser/
├── anki-card-standards/
├── anki-connect/
├── best-practices/
├── ...
└── zoom-out/

Excluded by explicit user preference: `api-design` and `github-workflows` must not appear in the repo or install target.
```

Each skill remains a normal Agent Skills directory:

```text
skill-name/
└── SKILL.md
```

Additional support files within a skill are preserved as-is.

## Frontmatter policy

Repo copies must exclude local runtime policy fields such as:

```yaml
disable-model-invocation: true
```

Reason: the consuming system should decide whether a skill is auto-invoked, manual-only, hidden, or otherwise filtered.

Install scripts may optionally inject `disable-model-invocation` into installed copies under `~/.agents/skills`, but the repo should hold the upstream/default skill content.

## What to include

Include skills that are currently managed as user skills under:

```text
/home/gm/.agents/skills
```

Also include existing repo-only skills that are not currently installed under `.agents/skills`, such as `anki-connect`, `build-react-codebase-guidelines`, `improve-frontend-architecture`, and `review-react-codebase-red-flags`.

If a package also includes a duplicate skill name, that is fine. The repo may contain the user-managed copy. But do not purposefully add package-only skills just because a package exists.

## What not to include

Do not include skills explicitly removed by user preference:

```text
api-design
github-workflows
```

These were removed from `/home/gm/.agents/skills` and should not be recreated by sync/install scripts.

Do not include skills that only come from installed packages/extensions, for example:

```text
context-mode package skills
pi-subagents package skills
pi-web-access / librarian package skill
matt-workflow extension-only bundled skills
```

Examples intentionally excluded unless later copied into `.agents/skills` by choice:

```text
context-mode
ctx-doctor
ctx-insight
ctx-purge
ctx-stats
ctx-upgrade
grill-me from context-mode
librarian
pi-subagents
matt-workflow
```

## Router skills

Keep the router skills as first-class repo skills:

```text
code-quality-review
frontend-design-quality
web-interface-quality
```

The specialist skills they route to should also remain as first-class repo skills. In repo copies, router references should eventually be made portable rather than hardcoded to `/home/gm/.agents/skills/...`.

Recommended router reference strategy after migration:

- During development in the repo: use relative paths where possible.
- During install: if Pi requires absolute paths in instructions, rewrite or template router paths to the target install directory.

## Scripts to add

### `scripts/sync-from-pi.ts`

Purpose: copy current user-managed skills from:

```text
/home/gm/.agents/skills
```

into the repo root, stripping local runtime-only frontmatter fields such as `disable-model-invocation`.

Behavior:

1. Scan `.agents/skills/*/SKILL.md`.
2. Copy each skill directory into the repo root.
3. Preserve helper files, references, workflows, scripts, templates, and assets.
4. Remove `disable-model-invocation` from copied frontmatter.
5. Do not copy package-only skills from `node_modules`.
6. Report repo-only skills that are not installed in `.agents/skills`.

### `scripts/install-to-pi.ts`

Purpose: install repo skills into:

```text
/home/gm/.agents/skills
```

Behavior:

1. Copy each repo skill directory to `.agents/skills`.
2. Optionally apply local install policy from `skills.lock.json`.
3. Inject `disable-model-invocation: true` only into installed copies when configured.
4. Never mutate the repo copy to add runtime policy.
5. Preserve existing unknown local skills by default unless explicitly pruning.

### `scripts/audit-skills.ts`

Purpose: validate repo health and compare installed/upstream state.

Required checks:

1. Every skill directory has `SKILL.md`.
2. `name` matches directory name.
3. `description` exists.
4. Repo copy does not contain `disable-model-invocation`.
5. `SKILL.md` size is reasonable; flag oversized files for possible router/reference extraction.
6. Duplicate skill names are reported.
7. Installed copy under `.agents/skills` is compared with repo copy.
8. For non-personal skills installed from skills.sh or matching skills.sh, compare against upstream when possible.

## skills.sh tracking design

Add a lock file:

```text
skills.lock.json
```

Suggested shape:

```json
{
  "version": 1,
  "skills": {
    "tdd": {
      "origin": "skills.sh",
      "source": "mattpocock/skills",
      "skill": "tdd",
      "installCommand": "npx skills add https://github.com/mattpocock/skills --skill tdd",
      "upstreamUrl": "https://github.com/mattpocock/skills/tree/main/skills/engineering/tdd",
      "localPolicy": {
        "disableModelInvocation": true
      }
    },
    "code-quality-review": {
      "origin": "personal",
      "localPolicy": {
        "disableModelInvocation": false
      }
    }
  }
}
```

For skills installed from skills.sh or known to match skills.sh, `audit-skills.ts` should:

1. Resolve the upstream GitHub source from `skills.lock.json` or skills.sh metadata.
2. Fetch latest `SKILL.md` and support files where practical.
3. Compare hashes against the repo copy.
4. Report:
   - `up-to-date`
   - `upstream-updated`
   - `local-modified`
   - `conflict/manual-review`

This is intended for non-personal skills installed from skills.sh or npx skills, not for personally-authored local skills.

## Current skill inventory and proposed ordering

Legend:

- `existing repo`: already present in `/home/gm/workspace/skills`.
- `skills.sh match`: appears to match a skills.sh-installable upstream, especially `mattpocock/skills`.
- `skills.sh likely match`: web search found a plausible matching skill, but exact installed provenance is not proven.
- `personal/local`: no confirmed skills.sh match; likely local/personal/user-managed.
- `router`: locally-created router skill.

| Order | Skill | Include? | Current source | Proposed origin | skills.sh status | Notes |
|---:|---|---|---|---|---|---|
| 1 | accessibility | yes | `.agents/skills/accessibility` | skills.sh likely match | plausible Addy Osmani/web-quality-skills match | Strip disable flag in repo. |
| 2 | agent-browser | yes | `.agents/skills/agent-browser` | personal/local | unknown | Keep as normal skill. |
| 3 | anki-card-standards | yes | repo + `.agents/skills` | existing repo | unknown | Repo copy already exists. Reconcile with installed copy. |
| 4 | anki-connect | yes | repo only | existing repo | unknown | Keep repo skill. |
| 5 | api-design | no | removed | user removed | removed | Removed from runtime and repo; do not migrate. |
| 6 | best-practices | yes | `.agents/skills/best-practices` | skills.sh likely match | likely Addy Osmani/web-quality-skills family | Strip disable flag in repo. |
| 7 | btca-cli | yes | `.agents/skills/btca-cli` | personal/local | unknown | Local tooling skill. |
| 8 | build-react-codebase-guidelines | yes | repo only | existing repo | unknown | Keep repo skill. |
| 9 | code-optimizer | yes | `.agents/skills/code-optimizer` | personal/local | unknown | Strip disable flag in repo. |
| 10 | code-quality-review | yes | `.agents/skills/code-quality-review` | router | personal/local | New router skill; keep auto-policy out of repo. |
| 11 | coding-agent | yes | `.agents/skills/coding-agent` | OpenClaw-derived | OpenClaw upstream, locally installed from `openclaw/openclaw/skills/coding-agent` | Replaced local copy with the OpenClaw skill; repo copy should exclude runtime-only `disable-model-invocation`. |
| 12 | core-web-vitals | yes | `.agents/skills/core-web-vitals` | skills.sh likely match | likely Addy Osmani/web-quality-skills family | Strip disable flag in repo. |
| 13 | create-skill | yes | `.agents/skills/create-skill` | skills.sh match | `siviter-xyz/dot-agent/create-skill` | Replaced local GSD-specific copy with skills.sh upstream. Repo copy should exclude runtime-only policy fields. |
| 14 | create-workflow | no | removed | GSD-specific workflow authoring skill | removed | Removed from runtime; do not migrate into repo. |
| 15 | debug-like-expert | yes | `.agents/skills/debug-like-expert` | personal/local | unknown | Keep. |
| 16 | dependency-upgrade | yes | `.agents/skills/dependency-upgrade` | personal/local | unknown | Strip disable flag in repo. |
| 17 | design-an-interface | yes | `.agents/skills/design-an-interface` | personal/local | unknown | Strip disable flag in repo. |
| 18 | diagnose | yes | `.agents/skills/diagnose` | skills.sh match | `mattpocock/skills/diagnose` | Track upstream. |
| 19 | fallow | yes | `.agents/skills/fallow` | personal/local | unknown | Strip disable flag in repo. |
| 20 | find-skills | yes | `.agents/skills/find-skills` | personal/local | skills.sh directory-adjacent but provenance unknown | Strip disable flag in repo. |
| 21 | frontend-design | yes | `.agents/skills/frontend-design` | skills.sh likely match | skills.sh directory shows frontend-design entries | Strip disable flag in repo. |
| 22 | frontend-design-quality | yes | `.agents/skills/frontend-design-quality` | router | personal/local | New router skill. |
| 23 | github-workflows | no | removed | user removed | removed | Removed from runtime and repo; do not migrate. |
| 24 | grill-with-docs | yes | `.agents/skills/grill-with-docs` | skills.sh match | `mattpocock/skills/grill-with-docs` | Track upstream. |
| 25 | improve-codebase-architecture | yes | `.agents/skills/improve-codebase-architecture` | skills.sh match | `mattpocock/skills/improve-codebase-architecture` | Track upstream. |
| 26 | improve-frontend-architecture | yes | repo only | existing repo | unknown | Keep repo skill. |
| 27 | make-interfaces-feel-better | yes | `.agents/skills/make-interfaces-feel-better` | personal/local | unknown | Strip disable flag in repo. |
| 28 | observability | yes | `.agents/skills/observability` | generalized local cleanup | de-GSD'd from previous snapshot | Removed GSD-specific references and paths; strip disable flag in repo. |
| 29 | openclaw-config | no | removed | deprecated/obsolete OpenClaw config skill | removed | Removed from machine; do not migrate into repo. |
| 30 | prototype | yes | `.agents/skills/prototype` | skills.sh match | `mattpocock/skills/prototype` | Track upstream. |
| 31 | react-best-practices | yes | `.agents/skills/react-best-practices` | personal/local | unknown | Strip disable flag in repo. |
| 32 | review | yes | `.agents/skills/review` | personal/local | unknown | Strip disable flag in repo. |
| 33 | review-react-codebase-red-flags | yes | repo only | existing repo | unknown | Keep repo skill. |
| 34 | security-review | yes | `.agents/skills/security-review` | skills.sh/GitHub upstream | `getsentry/skills/security-review` | Replaced GSD snapshot; strip disable flag in repo. |
| 35 | setup-matt-pocock-skills | yes | `.agents/skills/setup-matt-pocock-skills` | skills.sh match | `mattpocock/skills/setup-matt-pocock-skills` | Track upstream. |
| 36 | tdd | yes | `.agents/skills/tdd` | skills.sh match + existing workflow | `mattpocock/skills/tdd` | Track upstream. |
| 37 | testing-philosophy | yes | repo + `.agents/skills` | existing repo | unknown | Reconcile repo/installed copies. |
| 38 | to-issues | yes | `.agents/skills/to-issues` | skills.sh match | `mattpocock/skills/to-issues` | Track upstream. |
| 39 | to-prd | yes | `.agents/skills/to-prd` | skills.sh match | `mattpocock/skills/to-prd` | Track upstream. |
| 40 | todoist-api | yes | `.agents/skills/todoist-api` | personal/local | unknown | Local integration skill. Strip disable flag in repo. |
| 41 | triage | yes | `.agents/skills/triage` | skills.sh match | `mattpocock/skills/triage` | Track upstream. |
| 42 | userinterface-wiki | yes | `.agents/skills/userinterface-wiki` | personal/local | unknown | Strip disable flag in repo. |
| 43 | web-design-guidelines | yes | `.agents/skills/web-design-guidelines` | personal/local | unknown | Strip disable flag in repo. |
| 44 | web-interface-quality | yes | `.agents/skills/web-interface-quality` | router | personal/local | New router skill. |
| 45 | web-quality-audit | yes | `.agents/skills/web-quality-audit` | skills.sh likely match | likely Addy Osmani/web-quality-skills family | Strip disable flag in repo. |
| 46 | write-docs | yes | `.agents/skills/write-docs` | skills.sh/GitHub upstream | `michalvavra/agents/write-docs` | Replaced GSD snapshot; strip disable flag in repo. |
| 47 | zoom-out | yes | `.agents/skills/zoom-out` | skills.sh match | `mattpocock/skills/zoom-out` | Track upstream. |

## Explicitly excluded package/extension skills

These are currently visible in Pi due to installed packages/extensions, but should not be included in this repository unless intentionally copied into `.agents/skills` later:

| Skill | Source | Reason excluded |
|---|---|---|
| context-mode | `node_modules/context-mode/skills` | package-provided |
| ctx-doctor | `node_modules/context-mode/skills` | package-provided |
| ctx-insight | `node_modules/context-mode/skills` | package-provided |
| ctx-purge | `node_modules/context-mode/skills` | package-provided |
| ctx-stats | `node_modules/context-mode/skills` | package-provided |
| ctx-upgrade | `node_modules/context-mode/skills` | package-provided |
| grill-me | `node_modules/context-mode/skills` and matt-workflow vendor | package/extension-provided only after `.agents` removal |
| librarian | `node_modules/pi-web-access/skills` | package-provided |
| matt-workflow | `.pi/agent/extensions/matt-workflow/skills` | extension entrypoint, not canonical general skill |
| pi-subagents | `node_modules/pi-subagents/skills` | package-provided |

## Migration phases

### Phase 1 — Document and verify

- Keep this plan in the repo.
- Review the inventory table.
- Decide whether `skills.sh likely match` entries should be tracked as upstream-managed or treated as local snapshots.

### Phase 2 — Sync into repo without runtime policy

- Copy `.agents/skills/*` into the repo root.
- Preserve existing repo-only skills.
- Strip `disable-model-invocation` from repo copies.
- Keep installed `.agents/skills` unchanged for now.

### Phase 3 — Add manifest and lock

- Generate `MANIFEST.md` from repo contents.
- Generate `skills.lock.json` with origin metadata.
- Mark Matt engineering skills as `origin: skills.sh` / `source: mattpocock/skills`.
- Mark personally-created skills as `origin: personal`.
- Mark uncertain matches as `origin: unknown` or `origin: skills.sh-candidate`.

### Phase 4 — Add scripts

- Implement `scripts/audit-skills.ts`.
- Implement `scripts/sync-from-pi.ts`.
- Implement `scripts/install-to-pi.ts`.

### Phase 5 — Make repo canonical

- Install from repo to `.agents/skills`.
- Optionally prune `.pi/agent/skills` duplicates later if desired.
- Keep package/extension skills managed by their owning packages.

## Open questions

1. Should plausible Addy Osmani/web-quality-skills matches be treated as upstream-managed skills.sh installs, or local snapshots?
2. Should Matt engineering skills be copied from current `.agents/skills` or refreshed directly from `mattpocock/skills` when first added to the repo?
3. Should router skills remain with absolute paths after install, or should install script rewrite paths from repo-relative references?
