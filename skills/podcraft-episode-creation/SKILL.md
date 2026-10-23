---
name: podcraft-episode-creation
description: Create or import Podcraft episodes and verify playback and feeds.
disable-model-invocation: true
---

# Podcraft episode creation

Deliver one ready, playable episode from a topic, script, or existing recording.
The API workflow needs Python 3 and tailnet access. Audio uploads also use curl
and ffprobe. The local import CLI needs the Podcraft checkout.

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
Resolve the target series and run the selected branch's preflight.

Generated and BYOS commands have a client dry run. The local import CLI validates
with `--dry-run`. Multipart API imports use the read-only preflight in their
reference; uploading creates an episode.

**Complete when:** required dependencies pass, the series exists, and the source,
hash, metadata, and concrete submission command are recorded. Name any validation
that only the import API can perform during submission.

## 3. Authorize

Use the user's existing authorization for the resolved submission. If it does
not cover that submission, present the branch, series, title or topic, source
path and hash, and branch options for confirmation. Voice applies to Generated
and BYOS. Source ID and episode number apply to imports.

**Complete when:** preflight passes and the resolved submission is authorized.

## 4. Submit once

Run the selected branch's submission command once. Keep its response, diagnostics,
exit status, and episode ID in private evidence. Generated and BYOS submissions
start background generation. A successful import returns a ready episode.

If the response is lost or ambiguous, reconcile against existing episodes before
another submission. For repeat imports, follow the import reference's rules for
source IDs and preserve the original source and metadata.

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
