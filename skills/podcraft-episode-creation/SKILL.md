---
name: podcraft-episode-creation
description: Create or import Podcraft episodes and verify playback and feeds.
disable-model-invocation: true
---

# Podcraft episode creation

Deliver one ready, playable episode from a topic, script, or existing recording.
The API workflow needs Python 3 and tailnet access. Audio imports also need
ffprobe on this host. The local import CLI needs the Podcraft checkout.

## 1. Select the branch

- **Generated:** Podcraft researches and writes from a topic and summary. Read
  [references/generated.md](references/generated.md).
- **BYOS:** Podcraft renders the supplied script with text-to-speech. Read
  [references/byos.md](references/byos.md).
- **Import audio:** Podcraft preserves an existing MP3 or M4A AAC recording. Read
  [references/imports.md](references/imports.md).

**Complete when:** the branch and source are identified, and its reference is read.

## 2. Preflight

Set `SKILL_DIR` to this skill's absolute directory. Read
[references/api.md](references/api.md) for connection and branch readiness checks.
Resolve the target series and run the selected branch's preflight. When the
series is missing, plan its creation with the dry run in the API reference.

Each branch has a `--dry-run` that submits nothing: `create` for Generated and
BYOS, and `import` or the local import CLI for imports.

**Complete when:** the dry run passes with no blockers, the series exists or its
creation dry run passes, and the source, hash, metadata, and exact submission
command are recorded. For an API import, also record `serverOnlyChecks` as
pending.

## 3. Authorize

Use the user's existing authorization for the resolved submission. If it does
not cover that submission, present the branch, series, title or topic, source
path and hash, and branch options for confirmation. Voice applies to Generated
and BYOS. Source ID and episode number apply to imports. A new series is a
separate write: present its dry-run payload, and create it only after the user
authorizes that series. Then resolve it again before the episode submission.

**Complete when:** preflight passes and the resolved submission is authorized.

## 4. Submit once

Run the selected branch's submission command once. Keep its response, diagnostics,
exit status, and episode ID in private evidence. Generated and BYOS submissions
start background generation. A successful import returns a ready episode.

If the response is lost or unclear, run `reconcile` before another submission
(see [references/api.md](references/api.md)). For a repeat import, keep the
original source ID, source file, and metadata.

**Complete when:** one submission returns an episode ID, or a failed attempt has
preserved evidence.

## 5. Verify

Read [references/verification.md](references/verification.md). Wait for generation
only for Generated and BYOS. Verify an import's ready state and original audio.
Apply every delivery gate for the selected branch.

When the user wants separate podcast subscriptions or AntennaPod delivery, also
read [references/subscriptions.md](references/subscriptions.md).

**Complete when:** every required mechanical gate has pass/fail evidence, requested
subscriptions are reachable, and remaining human checks are named.

## Final report

Return the branch, series, title or topic, episode ID, duration, delivery links,
gate results, failure evidence, and human review still required. For a collection,
report verified imports against the expected released recordings and bonus items.
