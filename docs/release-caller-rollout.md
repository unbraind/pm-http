# Pinned Daily Release rollout

This package delegates release execution to pm-ops v2026.11.18 at
`c46a2419c63af3b348e6b559b0733ab0d9942cc7`. The package uses the matching
released pm-ops validator and explicitly permits empty changelog sections in
generation, checking and release notes. Dependabot covers the SHA through its
root github-actions ecosystem.

Package-owned inputs: `{"reconcile-only":"${{ (github.event_name == 'schedule' && github.event.schedule == '41 * * * *') || inputs.retire-unpublished == true }}","retire-unpublished":"${{ github.event_name == 'workflow_dispatch' && inputs.retire-unpublished == true }}","release-enabled":"${{ github.repository == 'unbraind/pm-http' && github.ref == 'refs/heads/main' && vars.PM_RELEASE_APPROVED == 'true' }}"}`. The owner has approved the package, so a daily schedule posts
approved releases while the hourly schedule only reconciles.

Cross-repository npm OIDC was proven by the merged pm-jira pilot in
[run 43639146392](https://github.com/unbraind/pm-jira/actions/runs/43639146392),
as recorded on [pm-ops #272](https://github.com/unbraind/pm-ops/issues/272#issuecomment-6884325024).
The npm trusted publisher names this package repository and its own release.yml.
The first release run must still pass Verify npm will accept this workflow's OIDC identity.
Only the orchestrator merges, dispatches and verifies publication.

The caller contracts replace assertions about removed private release implementation.
Implementation behavior belongs to the pinned pm-ops release harness. Package-owned
approval, script and permission contracts remain checked locally.

Tracking: [pm-http-76jn](https://github.com/unbraind/pm-http/blob/main/.agents/pm/epics/pm-http-76jn.toon)

New release admission remains manual. The only scheduled trigger is hourly
reconciliation with reconcile-only enabled; it cannot admit a new release.
The package-specific owner approval variable still gates every operation.
