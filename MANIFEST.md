# Skills Repository Manifest

Last audited: 2026-05-13

This manifest lists every current top-level repo skill directory exactly once. It also records skills that are intentionally absent and must not be recreated by sync or install tooling.

## Current repo skills

| Skill | Origin | Source status | Notes |
|---|---|---|---|
| accessibility | skills.sh likely match | plausible Addy Osmani/web-quality-skills match | Repo copy excludes runtime disable flag. |
| agent-browser | personal/local | unknown | Normal user-managed skill. |
| anki-card-standards | existing repo | unknown | Repo copy existed before migration; reconcile with installed copy as needed. |
| anki-connect | existing repo | unknown | Repo-only skill retained. |
| best-practices | skills.sh likely match | likely Addy Osmani/web-quality-skills family | Repo copy excludes runtime disable flag. |
| btca-cli | personal/local | unknown | Local tooling skill. |
| build-react-codebase-guidelines | existing repo | unknown | Repo-only skill retained. |
| code-optimizer | personal/local | unknown | Kept general skill; repo copy excludes runtime disable flag. |
| code-quality-review | router | personal/local | Locally-created router skill. |
| coding-agent | OpenClaw-derived | OpenClaw upstream, locally installed from `openclaw/openclaw/skills/coding-agent` | Repo copy excludes runtime-only `disable-model-invocation`. |
| core-web-vitals | skills.sh likely match | likely Addy Osmani/web-quality-skills family | Repo copy excludes runtime disable flag. |
| create-skill | skills.sh match | `siviter-xyz/dot-agent/create-skill` | Replaced prior local/GSD copy with skills.sh upstream. |
| debug-like-expert | personal/local | unknown | User-managed skill. |
| dependency-upgrade | personal/local | unknown | Repo copy excludes runtime disable flag. |
| design-an-interface | personal/local | unknown | Repo copy excludes runtime disable flag. |
| diagnose | skills.sh match | `mattpocock/skills/diagnose` | Track upstream. |
| fallow | personal/local | unknown | Repo copy excludes runtime disable flag. |
| find-skills | personal/local | skills.sh directory-adjacent but provenance unknown | Repo copy excludes runtime disable flag. |
| frontend-design | skills.sh likely match | skills.sh directory shows frontend-design entries | Repo copy excludes runtime disable flag. |
| frontend-design-quality | router | personal/local | Locally-created router skill. |
| grill-with-docs | skills.sh match | `mattpocock/skills/grill-with-docs` | Track upstream. |
| improve-codebase-architecture | skills.sh match | `mattpocock/skills/improve-codebase-architecture` | Track upstream. |
| improve-frontend-architecture | existing repo | unknown | Repo-only skill retained. |
| make-interfaces-feel-better | personal/local | unknown | Repo copy excludes runtime disable flag. |
| observability | generalized local cleanup | de-GSD'd from previous snapshot | GSD-specific references and paths removed. |
| prototype | skills.sh match | `mattpocock/skills/prototype` | Track upstream. |
| react-best-practices | personal/local | unknown | Repo copy excludes runtime disable flag. |
| review | personal/local | unknown | Kept general skill; repo copy excludes runtime disable flag. |
| review-react-codebase-red-flags | existing repo | unknown | Repo-only skill retained. |
| security-review | skills.sh/GitHub upstream | `getsentry/skills/security-review` | Replaced GSD snapshot; track upstream. |
| setup-matt-pocock-skills | skills.sh match | `mattpocock/skills/setup-matt-pocock-skills` | Track upstream. |
| tdd | skills.sh match + existing workflow | `mattpocock/skills/tdd` | Track upstream. |
| testing-philosophy | existing repo | unknown | Repo and installed copies exist; reconcile as needed. |
| todoist-api | personal/local | unknown | Local integration skill; repo copy excludes runtime disable flag. |
| to-issues | skills.sh match | `mattpocock/skills/to-issues` | Track upstream. |
| to-prd | skills.sh match | `mattpocock/skills/to-prd` | Track upstream. |
| triage | skills.sh match | `mattpocock/skills/triage` | Track upstream. |
| userinterface-wiki | personal/local | unknown | Repo copy excludes runtime disable flag. |
| web-design-guidelines | personal/local | unknown | Repo copy excludes runtime disable flag. |
| web-interface-quality | router | personal/local | Locally-created router skill. |
| web-quality-audit | skills.sh likely match | likely Addy Osmani/web-quality-skills family | Repo copy excludes runtime disable flag. |
| write-docs | skills.sh/GitHub upstream | `michalvavra/agents/write-docs` | Replaced GSD snapshot; track upstream. |
| zoom-out | skills.sh match | `mattpocock/skills/zoom-out` | Track upstream. |

## Intentionally absent skills

These skills are deliberately absent from the repo and must not be installed or recreated by sync tooling.

| Skill | Reason | Status |
|---|---|---|
| api-design | User removed after prior replacement attempt. | Removed from runtime and repo; do not migrate. |
| github-workflows | User removed after prior replacement attempt. | Removed from runtime and repo; do not migrate. |
| create-workflow | GSD-specific workflow authoring skill. | Removed from runtime; do not migrate. |
| openclaw-config | Deprecated/obsolete OpenClaw config skill. | Removed from machine; do not migrate. |
