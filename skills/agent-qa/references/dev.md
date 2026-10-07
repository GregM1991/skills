# Development QA

Resolve the checkout, revision, setup command and start command from the request and trusted project configuration. Read project instructions before running them. Use the project's commands, then record the actual checkout revision. Verify that the configured URL serves this checkout. A hostname, including localhost, does not identify the environment.

Use authorized test accounts and fixtures. Run seeds or migrations only when the project workflow and existing authorization permit them. Keep credentials in their configured provider. Record credential references only.

Complete setup when the intended revision runs and the browser can open the target feature route, with authentication when the flow is gated. If setup fails, report that blocker. Keep the selected development target; production is not a substitute.
