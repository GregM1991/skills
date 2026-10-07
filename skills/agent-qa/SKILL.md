---
name: agent-qa
description: Run manual browser QA with recordings and screenshots, prefer T3, and report reproducible findings.
---

# Agent QA

Test the user's requested website or web application through the browser. Produce a report backed by screenshots and recordings. Keep application code unchanged unless the user separately requests fixes.

## Establish the run

Resolve the target environment from the request and trusted project configuration. Ask only when a target is unresolved or those sources conflict. Keep the selected target throughout the run. Existing authorization carries forward; a general QA request does not authorize unrelated production writes.

Identify the requested flow, account, test data and expected final state from the conversation and project configuration. List each requested check in run config before setup.

Read [development setup](references/dev.md) for a development target or [production setup](references/prod.md) for a production target. Complete that branch before testing. Use [run helpers](references/helpers.md) to validate config, check URL reachability, create the evidence manifest and count outcomes. Keep credentials and authentication state outside evidence.

Use requested screen sizes. For responsive QA without specified dimensions, use one desktop, tablet and mobile viewport, such as 1440 × 900, 820 × 1180 and 412 × 915. Describe these as browser viewport checks, not physical-device tests.

Record the browser backend and viewport sizes in the evidence directory created by the helper. Record the actual checkout or deployed revision in run config.

## Choose the browser

1. Prefer T3's collaborative browser. Discover its tools and call `preview_status`. If no automation-capable preview is attached, call `preview_open` before deciding that T3 is unavailable.
2. Use `preview_navigate`, `preview_snapshot` and focused interaction tools when available. Correct actionable tool errors and retry. A closed preview or an initial failure alone is not a fallback trigger.
3. Use the terminal fallback only when T3 preview tools are absent, `preview_open` explicitly reports unsupported or unavailable automation, or the user authorizes another browser. If T3 remains broken without one of these conditions, report the error and request fallback authorization.

For the fallback, read the installed `agent-browser` skill and its current CLI workflow instructions. Run the CLI through the terminal in a dedicated standalone headless Chromium session. Use its installed help for commands instead of copying commands from older runs.

For either backend, use fresh snapshots and their element references after navigation or substantial page changes. Inspect rendered screenshots to judge layout, clipping and readability; DOM text alone cannot establish visual correctness.

## Authenticate and capture evidence

For gated flows, reuse an authorized authenticated session when available or use the configured credential provider's secret-injection workflow. If that provider is 1Password, read the installed `onepassword-agent-secret-flows` skill. Keep secret values out of tool output, scripts, reports and recordings. For interactive login that cannot be completed here, consult `capture-agent-browser-auth-state` when installed and request only the missing human step.

Start recording after authentication and before the tested flow. Use the chosen backend's documented recording tools. Save screenshots at key states and every finding, including each tested viewport. Inspect the saved screenshots directly with the available image-viewing tool.

If recording is unavailable, disclose the limitation and capture a screenshot sequence. Label that evidence accurately. If video is a prerequisite in the user's request, resolve recording access before making the requested application changes. A recording limitation does not itself authorize switching browsers.

## Exercise the flow

First observe the target feature route, with authentication when the flow is gated, then follow the user's steps through the visible UI to the requested end state. Capture evidence for both `target-route` and `final-state`. Verify persisted results by revisiting or refreshing when appropriate. APIs and logs may explain a failure, but cannot substitute for a browser step being tested.

When the flow creates data, create it once and reuse it for responsive checks unless separate records are necessary and authorized. After an uncertain submission, inspect the application's state before retrying so a timeout does not create duplicates.

At each viewport, check that the controls needed for the flow remain visible and usable, dialogs fit, and the resulting content can be read. Exercise responsive navigation and controls instead of only resizing for screenshots. Record which steps were exercised at each size and which were only inspected.

Stop the flow on a major issue: the main path cannot continue, data is lost or corrupted, access crosses an account boundary, or continuing would compound damage. Save evidence and report the last successful step. Continue past minor visual or usability issues only while the main flow remains safe and usable. Honor any stricter stop condition from the user.

## Finish and report

Stop and save recordings. Inspect saved artifacts, then run the helper report with observations for every requested check. Close browser sessions created for this run. Leave shared sessions and production records intact unless cleanup was authorized.

Write a report in the evidence directory with:

- Target environment, browser backend and viewport dimensions.
- Requested steps and their outcomes, distinguishing passed, failed and untested checks.
- Findings with severity, reproduction steps, expected and actual behavior, and evidence links.
- Created or changed records, their URLs where available, and any incomplete work or evidence gaps.

Link the report and key screenshots or recordings in the final response. Claim end-to-end success only when the requested final state was observed and the required checks completed. If the run stopped, state where and why.
