# Scoped npm validation

Tracking: [pm-http-scoped-npm-name](https://github.com/unbraind/pm-http/blob/main/.agents/pm/chores/pm-http-scoped-npm-name.toon).

npm refused the first unscoped publish on 2026-11-15 with E403 because `pm-http` is too similar to `pmhttp`. The owner selected `@unbrained/pm-http`, following [pm-lint PR 29](https://github.com/unbraind/pm-lint/pull/29). Manifest identity, catalog display name and `pm http` commands remain unchanged. The existing homepage and public publish access are retained.

## Packed consumers

Network commands use `export NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000`. `npm run test:install` builds and packs `unbrained-pm-http-2026.10.29.tgz`, checks the scoped npm identity, and checks native Bun packing as well:

```sh
npm pack --json --ignore-scripts --pack-destination "$PROOF"
bun pm pack --ignore-scripts --destination "$BUN_PACK" --quiet
```

Scratch variables stand for fresh local directories and the packed archive. Each npm/Bun consumer gets a private manifest with `"@unbrained/pm-http": "file:<tarball>"` and `"@unbrained/pm-cli": "2026.10.28"` dependencies. In separate fresh prefixes, the test runs `npm install --ignore-scripts` and `bun install --ignore-scripts`. Both install the same tarball. It verifies the installed `node_modules/@unbrained/pm-http/package.json` name and rejects a successful Git-worktree probe in either consumer.

Each consumer then runs the README's activation path through its own host:

```sh
npx --no-install pm init --prefix packed --defaults --agent-guidance skip
npx --no-install pm config project set agent_identity.probes_enabled false
npx --no-install pm package install "$TARBALL"
npx --no-install pm create Task 'Packed API investigation' --json
```

The Bun journey uses `bunx --bun --no-install pm` with the same arguments. Activation retains manifest name `pm-http`. Against a synthetic loopback fixture, both journeys add a probe, send it once with a stable operation ID, declare a status/JSON-shape contract, compare it and produce a bounded difference packet. `http compare` reports `satisfies`. Scoped SDK imports then exercise observations, comparisons, missing evidence, stale revisions, withdrawn authorization, protocol upgrade recovery and capacity refusal. The tests assert only one ordinary fixture request, one upgrade, and an unchanged packed artifact hash.

There is no standalone extension executable: npx/bunx invoke the pm host. The documented registry activation is `pm install npm:@unbrained/pm-http`. Publication and actual registry installation are outside this validation.

## Release and gates

The reusable release remains pinned to pm-ops `7687a35d7522482bd8361d60dbc2589e9afbc81c`. Inspection of that exact workflow confirms there is no package-name input: packing, OIDC and npm metadata checks derive `package.json.name`; Bun receives the package identity from the release intent. The caller retains its project-root default, publication and Bun-verification defaults, permissions and maintainer approval gate.

Targeted command:

```sh
node --test --test-concurrency=2 test/package-metadata.test.ts test/release-workflow.test.ts test/workflow.test.ts test/tooling.test.ts test/automation-changelog.test.ts
```

Additional commands: `pm test pm-http-scoped-npm-name --run --progress`, `npm run test:install`, `npm run typecheck`, `npm run lint`, `npm run pack:dry-run`, `npm run verify:release-publish-attestation`, `npm run identity:check`, `npm run changelog:full`, and `npm run changelog:check`. Full repository coverage was not run: coverage source files are unchanged. Tooling regressions exercise their existing synthetic coverage fixtures only.

CI v2 PR 34's branch, workflows and tests are untouched; the generated changelog is the only overlap. No npm publish, merge or review-thread action was performed.

The targeted suite passes 52/52 directly and 52/52 through the linked pm test runner, with zero failures or skips. Typecheck, lint, pack dry-run (47 allowlisted files) and publish-attestation verification pass.

Packed acceptance passes 2/2 with zero failures or skips: npm/npx and Bun/bunx both activate the scoped artifact and complete the real synthetic investigation and SDK journey. Identity/privacy and regenerated changelog checks also pass.
