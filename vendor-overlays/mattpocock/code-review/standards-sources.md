## Standards sources and fixes

Add these rules to the **Standards** sub-agent prompt:

- **Standards come from the fixed point.** Read each standards source as it exists at the merge-base (`git show <merge-base>:<path>`). A document the diff adds or changes is part of the change under review: review it, and cite only its merge-base version as authority.
- **Tooling covers only what it detects.** Text-clone detectors (jscpd, Fallow's default mode) match copied text and miss the same rule written in different words. Duplicated Code across files and tickets stays with this sub-agent. When the repository documents a semantic duplicate report, run it and pass its output to the sub-agent as candidates to verify.
- **Fixes name their owner.** Each finding's suggested fix states what it removes or which existing owner it reuses before anything it adds. Prefer extending the existing owner of the behaviour over a new guard, helper or test.
