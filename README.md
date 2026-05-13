# Skills

Canonical repository for personal/user-managed agent skills installed into Pi at:

```text
/home/gm/.agents/skills
```

## Commands

Run commands from this repository root:

```bash
cd /home/gm/workspace/skills
```

Audit the repo:

```bash
bun scripts/audit-skills.ts
```

Preview installing repo skills into Pi:

```bash
bun scripts/install-to-pi.ts --dry-run
```

Install repo skills into Pi:

```bash
bun scripts/install-to-pi.ts
```

Preview syncing curated runtime skills back into the repo:

```bash
bun scripts/sync-from-pi.ts --dry-run
```

Sync curated runtime skills back into the repo:

```bash
bun scripts/sync-from-pi.ts
```

## Exclusion policy

Do not add or recreate explicitly removed skills:

```text
api-design
github-workflows
create-workflow
openclaw-config
```

Do not add package-only or extension-only skills unless they are intentionally copied into `/home/gm/.agents/skills` and added to the manifest.

Repo `SKILL.md` files must not contain runtime-only policy fields such as:

```yaml
disable-model-invocation: true
```
