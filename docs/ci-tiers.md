# Fleet CI v2

Required checks remain `test (22)`, `test (26)` and `codeql`. PR/manual CI
preserves the original `PM_LOCAL_RUNNER` expression exactly: authorized same-repo
PRs use the selected local x64/ARM64 pool and fork PRs fall back to hosted Ubuntu.
Each PR job has a 30-minute limit, harness scale 3 for the local pool, and superseded PR runs cancel. Required CodeQL
is unfiltered, keeps Monday 01:47 UTC, and has a 30-minute limit.

| Check | Code PR 22 | Code PR 26 | Docs/tracker PR, both | Deep 22 + 26 |
| --- | --- | --- | --- | --- |
| npm ci / prepare merge drivers / strict health | yes | yes | yes | yes |
| Commit identities / added private paths | yes | yes | yes | standalone + npm/Bun gates |
| Build, test typecheck and unit/SDK/transport suite | quick | quick coverage | prepack build; tooling/docs subset | full, npm + Bun gates |
| Typecheck, lint, duplication, docstrings | — | yes | — | npm + Bun gates |
| Coverage: unchanged 100% statements/branches/functions/lines, full authored scope | — | quick | — | full, npm + Bun gates |
| Production dependency audit | — | yes | — | npm + Bun gates |
| Package dry-run and public file allowlist | — | yes | yes | npm + Bun gates |
| Changelog consistency | — | yes | yes | npm + Bun gates |
| Publish attestation verifier | — | yes | — | npm + Bun gates |
| Packed npm/npx/Bun/bunx no-Git investigation and SDK acceptance | — | yes | — | npm + Bun gates |
| Bun package graph smoke / version log | — | yes | — | yes |
| Tooling identity and release-document contracts, changelog automation tests | via suite | via suite | yes | npm + Bun gates |
| CodeQL | separate required workflow on every PR/main push, plus weekly scan | same | same | same |

Deep checks `deep (22)` and `deep (26)` run on main pushes, dispatch and nightly
02:23 UTC, separate from the release caller's hourly :41 schedule. They execute
both full npm/Bun gates at `PM_TEST_DEPTH=full`, `PM_TEST_TIME_SCALE=3`, with
per-ref cancellation and a 120-minute limit. Deep uses `pm-local-arm64` unless
`PM_LOCAL_DEEP=off`, then hosted Ubuntu. Local npm retains its persistent cache;
Bun setup runs only on hosted runners and all code/deep Node 26 jobs log Bun.
The same cache/setup optimization applies to the existing local PR route.
Release workflows, pm-github workflows and verifier scripts remain unchanged.

This package has no 500-seed corpus. Its two repetitive 128-case deterministic
loops (context identity and generated media subtypes) run their first 25 cases in
quick mode. Full/unset depth runs all 128. Exact capacity/revision boundaries,
all HTTP methods/phases and actual process-crash cases remain complete. Large
payload fixtures are product capacity contracts and are not reduced. Coverage
thresholds and source scope, including scripts, remain unchanged.

Only harness timeouts scale: CLI child watchdogs, investigator processes and the
outer transport-promise guard. Factors must be finite and positive; deadlines
round up to integer milliseconds, and investigator budgets validate before spawn.
Product probe timeoutMs values, DNS deadlines, cancellation scenarios and other
promised product budgets stay unscaled. Existing packed acceptance remains
unchanged; it already proves npm/Bun installation, npx/bunx and SDK execution.
The extra PR Bun action therefore only installs the dependency graph.

Docs/tracker detection uses a NUL-delimited PR base/head diff without rename
folding. Executable tracker files select the code tier. Cheap runs retain strict
health, identity audit, changelog checks, package dry-run plus the packed public
file allowlist, and tooling/changelog documentation contracts. There is no
standalone Markdown linter. CodeQL remains required even for docs-only changes.

Baseline successful main run 43712552108: Node 26 wall 35m16s/execution 32m41s;
Node 22 wall 88m36s/execution 21m21s. Logs show exact serialized byte-boundary
admission at 128.12–129.86s, concurrent admission at 63.74–63.85s, packed npm/npx
at 77.35–79.21s and packed Bun/bunx at 54.84–59.03s. These are historical ARM64
measurements, not a same-host quick/full comparison. Full depth is not run
locally; the task and PR record quick proof and available PR CI timing.

Local quick coverage passed 151/151 tests in 527.65s suite time, with exactly
100% in all four dimensions across all 20 authored source files. Exact admission
boundary took 123.09s and concurrent admission 82.50s. Local Node was 24; these
are not same-host full/quick or Node 22/26 comparisons. Full depth stays deferred
to deep CI. Local strict health reports a host-global extension/SDK skew; the
strict CI gate is retained for independent runner evidence. No product flake was
found; scaled harness guards address slow scheduling without relaxing contracts.
