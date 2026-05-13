---
description: Atomic implementation plan for migrating curated user-managed skills into the skills repository.
---

# Skills Repository Implementation Plan

## TL;DR

Execute this plan from `/home/gm/workspace/skills`. The runtime source is `/home/gm/.agents/skills`; the repo must stay portable and must not contain runtime-only `disable-model-invocation` metadata. Do not recreate `api-design`, `github-workflows`, `create-workflow`, or `openclaw-config`.

## Guardrails

- Preserve `/home/gm/.agents/skills` as the current runtime source.
- Keep this repo flat: one top-level directory per skill.
- Exclude package-only skills unless they have been intentionally copied into `/home/gm/.agents/skills`.
- Strip repo copies of local runtime policy fields, especially `disable-model-invocation`.
- Do not include these removed skills: `api-design`, `github-workflows`, `create-workflow`, `openclaw-config`.
- Do not delete `.gsd` project folders or Matt workflow extension files.

## Definition of done

- Repo contains every included skill from the migration inventory.
- Repo does not contain explicitly excluded or package-only skills.
- No checked-in `SKILL.md` contains `disable-model-invocation`.
- Router skills remain present and reference specialist skills portably or have a documented rewrite step.
- `MANIFEST.md` and `skills.lock.json` reflect the final repo contents.
- `scripts/audit-skills.ts`, `scripts/sync-from-pi.ts`, and `scripts/install-to-pi.ts` exist and are runnable.
- A dry-run install shows no accidental recreation of excluded skills.

## Task checklist

| ID | Task | Atomic acceptance check |
|---|---|---|
| 01 | Confirm working tree state in `/home/gm/workspace/skills`. | `git status --short` output is recorded before edits. |
| 02 | Read `MIGRATION-PLAN.md` and treat its inventory table as the source of truth. | Agent can list included and excluded skills before copying. |
| 03 | Create an exclude list in notes or script constants. | List contains `api-design`, `github-workflows`, `create-workflow`, `openclaw-config`, plus package-only skills from the plan. |
| 04 | Create an include list from the inventory rows where `Include?` is `yes`. | Include list excludes every removed skill. |
| 05 | For each included `.agents` skill, copy its full directory into the repo. | Skill directory exists in repo with `SKILL.md` and support files preserved. |
| 06 | For existing repo-only skills, keep them unless the plan marks them excluded. | `anki-connect`, `build-react-codebase-guidelines`, `improve-frontend-architecture`, and `review-react-codebase-red-flags` remain present. |
| 07 | Remove any accidentally copied excluded skill directories from the repo. | `test ! -e api-design && test ! -e github-workflows && test ! -e create-workflow && test ! -e openclaw-config`. |
| 08 | Strip `disable-model-invocation` from all repo `SKILL.md` files. | `grep -R "disable-model-invocation" .` returns no skill-file hits. |
| 09 | Preserve non-runtime frontmatter and all skill support files. | Spot-check `create-skill/references/*`, `security-review/references/*`, and router skill files. |
| 10 | Review router skills for hardcoded `/home/gm/.agents/skills` paths. | Any hardcoded runtime paths are either replaced with portable wording or listed for install-time rewriting. |
| 11 | Write `MANIFEST.md` with skill names, origin, source status, and notes. | Manifest includes every repo skill exactly once and marks excluded skills as intentionally absent. |
| 12 | Write `skills.lock.json` for upstream-trackable skills. | Lock file includes skill name, origin repo/ref when known, local path, and last-audited date. |
| 13 | Add `scripts/sync-from-pi.ts`. | Script can copy included runtime skills into the repo while honoring the exclude list and stripping runtime metadata. |
| 14 | Add `scripts/install-to-pi.ts`. | Script can install repo skills into `/home/gm/.agents/skills` and refuses to install excluded skills. |
| 15 | Add `scripts/audit-skills.ts`. | Script compares repo contents, runtime contents, manifest, lock file, and skills.sh-upstream candidates. |
| 16 | Run the audit script. | Audit reports no unexpected excluded skills and no checked-in runtime metadata. |
| 17 | Run install script in dry-run mode. | Dry run shows intended file operations only; no excluded skill appears. |
| 18 | Run a final repo inventory check. | Top-level skill dirs match `MANIFEST.md` and migration inventory decisions. |
| 19 | Update `README.md` with install/sync/audit commands. | README has concise commands and states the exclusion policy. |
| 20 | Record final verification output in the implementation notes or commit message. | Verification includes removed skills absent, runtime metadata stripped, and scripts passing. |

## Recommended execution order

1. Inventory first: tasks 01-04.
2. Copy and sanitize skills: tasks 05-10.
3. Add repo metadata: tasks 11-12.
4. Add automation scripts: tasks 13-15.
5. Verify and document: tasks 16-20.

## Script behavior requirements

### `scripts/sync-from-pi.ts`

- Input: `/home/gm/.agents/skills` by default.
- Output: current repo root by default.
- Must support `--dry-run`.
- Must skip excluded skills.
- Must copy support files recursively.
- Must strip runtime-only frontmatter fields from copied `SKILL.md` files.

### `scripts/install-to-pi.ts`

- Input: current repo root by default.
- Output: `/home/gm/.agents/skills` by default.
- Must support `--dry-run`.
- Must refuse to install excluded skills even if directories exist locally.
- May optionally inject local runtime policy fields during install, but only from an explicit config.

### `scripts/audit-skills.ts`

- Must verify excluded skills are absent from the repo.
- Must verify no repo `SKILL.md` contains `disable-model-invocation`.
- Must verify every manifest skill has a directory and every skill directory appears in the manifest.
- Should compare skills.sh/GitHub upstream entries for lock-file skills when possible.
- Should print a concise pass/fail summary suitable for another agent to act on.

## Final verification commands

```bash
cd /home/gm/workspace/skills
find . -maxdepth 2 -name SKILL.md | sort
grep -R "disable-model-invocation" . || true
test ! -e api-design && test ! -e github-workflows && test ! -e create-workflow && test ! -e openclaw-config
```
