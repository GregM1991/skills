# Production QA

Resolve the deployed URL and revision from the request and trusted deployment configuration. Record the deployed revision, or `unknown` when the deployment does not expose it. Describe that limit in the report. Use the existing authorized account or the configured credential provider.

Test within the user's existing authorization. Request clarification only for actions outside that scope. Production QA uses deployed data and services. Development seeds, migrations and local setup commands do not belong in this branch.

Complete setup when the browser can open the target feature route, with authentication when the flow is gated on the selected deployment. HTTP success or a login page alone does not prove readiness. Keep created records unless cleanup was authorized.
