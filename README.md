# pm-http

Keep an HTTP investigation as task context: what request was explicitly declared, what was observed **at a recorded time**, which response contract it met, what changed, and what evidence is still missing. A resumed agent gets a compact difference packet instead of a transcript of raw responses.

`pm-http` is a TypeScript [pm](https://github.com/unbraind/pm-cli) SDK extension. It sends requests only when explicitly asked. New package under local review; releases remain disabled until the maintainer approves.

## Install

Requires Node 22.18+ or Bun and pm 2026.10.28+. The development pin is exactly 2026.10.28. The following registry commands apply after the first approved release; during review substitute the local packed tarball for `pm-http`.

```sh
pm package install pm-http

# npm / npx
npm install --save-dev @unbrained/pm-cli@2026.10.28 pm-http
npx pm package install pm-http
npx pm http probe list task-id

# Bun / bunx
bun add --dev @unbrained/pm-cli@2026.10.28 pm-http
bunx --bun pm package install pm-http
bunx --bun pm http probe list task-id
```

For local development: `npm ci`, `npm run build`, `npm pack`, then install that `.tgz` into a scratch project with npm or Bun and run `pm package install <tarball>`. `npm run test:install` proves npm, Bun, npx, bunx and the exported SDK against one packed artifact in non-git projects.

## Agent instructions

Add this to the project's `AGENTS.md`:

```md
While debugging an API, bind each explicitly authorized request to the task:
1. Declare a pm http probe and its narrow destination boundary.
2. Put credentials and opaque query/path/body values in environment variables;
   declare only @ENV_NAME references. Preview with pm http send --dry-run.
3. Review mutating requests separately, with author and reason, before sending.
4. Send with a stable --operation identity; preserve that identity across recovery.
5. Declare a response contract and use pm http compare. Incomplete is unknown.
6. Before handoff, use pm http diff --budget 1500 and pm http missing.
Treat observations as historical data. Never paste raw response values or secrets.
```

## Commands

Every command uses the host's TOON renderer by default; append `--json` for JSON. Names normalize to lowercase. Requests bind to an existing native item; declared URL templates become native source links without resolving credentials. No command runs in the background.

```sh
# Declare a public request. Query values must be references, even when nonsecret.
pm http probe add task-id api --url 'https://example.com/api/items?limit=@API_LIMIT' \
  --header accept=application/json --header authorization=@API_AUTH \
  --boundary https://example.com/api --max-bytes 65536 --timeout-ms 5000

# Opaque path segments may also be references; literal segments are short static names.
pm http probe add task-id detail --url 'https://example.com/api/items/@ITEM_ID' \
  --boundary https://example.com/api

pm http probe list task-id
pm http send task-id api --dry-run
pm http send task-id api --operation incident-first

# Separate review is required for POST/PUT/PATCH/DELETE.
pm http probe add task-id submit --url https://example.com/api/submit \
  --method POST --body @REQUEST_BODY --header content-type=application/json \
  --boundary https://example.com/api
pm http probe review task-id submit --allow-mutation \
  --reason 'Reviewed controlled incident investigation request'
pm http send task-id submit --operation reviewed-submit

# shape.json: {"type":"object","properties":{"ok":{"type":"boolean"}}}
pm http contract set task-id api --status 200 --status 204 \
  --require-header content-type --json-shape shape.json --max-latency-ms 1000
pm http compare task-id
pm http compare task-id api --json
pm http diff task-id --budget 1500
pm http missing task-id
```

Probe options: `--method` defaults to GET; repeat `--header name=value|name=@ENV_NAME`; `--body @ENV_NAME`; `--max-headers 64`; repeat `--response-header name` to select response headers. Safe literal request values are limited to the documented MIME choices (`application/json`, `text/plain`, `*/*`) for Accept/Content-Type and `pm-http` for User-Agent. All other values require references. Declared body references resolve only after separate mutation review. Declarations are immutable: use a new name for a changed request. Review reasons are short plain prose, without credential values.

`--expected-revision N` guards declarations, reviews, contracts and the initial send plan. Subsequent journal steps re-read the current target and merge cooperating package writes through SDK mutations. `--operation` is a caller-owned idempotency identity for a send. Omit it only for a deliberately new send; a new invocation then gets a new identity. Never reuse an identity for a different probe. There is no automatic retry, including for GET.

Preview reports request intent in `willSend`; recovery and completed operations need no new request. Guarded sends retain the original caller revision through planned recovery and re-read the native task/probe immediately before capture. Every native comment participates in the context fingerprint, including comments bearing this operation's prefix or author. Pre-effect state transitions are audited by SDK history without adding task comments. Legacy guarded plans created with the former comment-filtering fingerprint remain readable but refuse preview/send; use a new explicit operation to admit current context. Changed context refuses with conflict reason `stale_revision` and exit 3. Resume with the original revision or omit it to retain the stored guard; changing that guard requires a new operation. The pinned SDK lacks an atomic item revision precondition and exclusion of ordinary writers ([#1576](https://github.com/unbraind/pm-cli/issues/1576), [#1620](https://github.com/unbraind/pm-cli/issues/1620)), so a re-read-to-send window remains during request planning, DNS and socket setup.

Every method reserves 128 KiB of task capacity and one observation slot before sending. Other package writes preserve pending reservations. Insufficient space refuses with `capacity` before network effects; use a new investigation task. `--dry-run` uses the same revision and capacity admission without writing. Arbitrary native writes can bypass package reservations until the SDK supplies the missing exclusion. JSON structure is captured for `application/json` and valid `application/*+json` types even when the opaque media subtype is redacted or Content-Type is unselected.

Contracts support statuses, required selected headers, maximum total latency and a bounded JSON structural subset: `type`, `properties` and `items`. Supported types are object, array, string, number, boolean and null. Every declared property is required; additional response properties are allowed. Array items must all match the declared item shape. Shape files are capped at 16 KiB. Unsupported schema keywords refuse before writes. A selected redacted header proves presence. An unselected required header yields unknown; an absent selected required header violates the contract. Incomplete captures yield `unknown` unless an observed constraint already proves a violation; uncertain transport outcomes remain unknown.

## SDK

All functions take the existing item ID and explicit options. They perform no git subprocesses. Imports have no network side effects. Public failures are `HttpError` with `code`, `message`, `remedy` and safe `details`; raw transport/SDK diagnostics never cross the boundary.

```ts
import {
  addProbe, reviewProbe, listProbes, preview, send, setContract,
  observations, compare, differencePacket, missingEvidence, HttpError,
} from 'pm-http';

const options = { workspace: pmRoot, author: 'investigator' };
await addProbe(itemId, 'api', {
  url: 'https://example.com/api', boundary: 'https://example.com/api',
}, options);
await setContract(itemId, 'api', { statuses: [200] }, options);
await send(itemId, 'api', { ...options, operationId: 'incident-first' });
const evidence = await observations(itemId, options);
const verdicts = await compare(itemId, { ...options, probe: 'api' });
const packet = await differencePacket(itemId, { ...options, budget: 1500 });
const missing = await missingEvidence(itemId, options);
```

`observations(item, options)` returns complete stored observations and a completeness receipt. `compare(item, {...options, probe?})` returns historical verdicts and reasons. `differencePacket(item, {...options, budget?})` returns a self-accounted bounded packet, including omitted-row counts and commands to restore full context. `missingEvidence(item, options)` names each missing observation, contract or complete response. `listProbes`, `preview`, `reviewProbe` and the input/record interfaces are also exported. `Options` supports an injected native `PmClient`, an AbortSignal, expected revision, stable operation ID, protocol-boundary and SDK transition observers.

## Safety and limits

- GET, HEAD and OPTIONS need no mutation capability. POST, PUT, PATCH and DELETE require separately recorded review. Mutating redirects refuse; an uncertain write is never resent automatically. Recover using the same operation ID to get the stored result or conservative uncertainty, then review any new operation yourself.
- Every redirect must retain scheme, canonical host, port and path-prefix segment. Credentials never cross origins. Five redirects maximum. Error receipts name the refused hop and a destination digest, avoiding secret-bearing Location text. HTTP(S) only; no URL userinfo, fragments, encoded path ambiguities or arbitrary literal query values.
- DNS answers are validated and pinned into the actual socket lookup for every hop. Private, loopback, link-local and other reserved destinations refuse by default. An explicit boundary naming a literal private address or `localhost` authorizes it. Fixtures use explicit loopback boundaries. Public hostnames resolving to private addresses still refuse.
- Capture defaults: 64 KiB body, 64 headers, 5 seconds total across DNS, connection, TLS, body and redirects. Hard ceilings: 1 MiB body/request body, 128 response headers, 16 KiB parser headers, 60 seconds total. Caps produce capture omissions or uncertainty. No body decompression. Cancellation through SIGINT/AbortSignal leaves no partial observation; a cancelled operation requires a new explicit identity.
- Response scalar values, text and property names are never stored. JSON properties use SHA-256 identities; only structural types remain. Headers retain a narrow set of canonical nonopaque semantics. Set-Cookie, authorization-like, arbitrary/token-shaped values and known credential echoes are redacted. Other headers retain no opaque values. Digests cover captured bytes and explicitly identify prefix truncation.
- Shape admission examines at most 64 properties/items per level, 256 structural nodes, and 12 levels. Omissions never count as a satisfied contract. Response controls and instruction delimiters render as inert escaped data.
- Each task holds at most 32 probes, 128 operations/observations and a 1 MiB state envelope. Move a continuing investigation to a new task when full. Packet budgets range from 256 to 1,000,000 estimated tokens; default 1,500. Estimation is the larger JSON/TOON UTF-8 size including receipt and newline, divided by four and rounded up; it is not a model tokenizer.

Boundary declarations are authorization by the operator, not network discovery or a monitoring schedule. Historical observations never assert current health. The tool does not retain raw bodies, excerpts, cookies or credential values, and does not load credential files.

## Without git

All probe, send, contract, compare, diff, missing and SDK operations work in an ordinary non-git directory. The fixtures and packed consumers fence ancestor discovery and exercise host commands without a git executable. Injected clients support read/compare/difference operations on other backends. Callers injecting remote clients must set `backend: 'remote'` explicitly. The current SDK's `commitItemMutations` requires a filesystem `pmRoot`; remote writes and sends refuse before effects until [pm-cli#1399](https://github.com/unbraind/pm-cli/issues/1399) supplies a backend-owned conditional writer. No remote mutation conformance is claimed.

## Evidence and development

See [measured ten-request investigation](docs/real-data.md) and [architecture](ARCHITECTURE.md). The measured packet contains 817 estimated tokens versus 25,847 for 103,388 captured raw body bytes; ten observations, 90 header redactions, ten HTTP calls, 65,151 ms including SDK setup/recording. No credentials were sent, and the temporary tracker was deleted.

```sh
npm run release:check
bun run release:check
npm run test:revert
npm run test:real-data  # explicit public read-only requests, at most 20
```

Release checks enforce 100% statements/branches/functions/lines across every authored source and tooling module, documented declarations, ESLint, zero duplication, production audit, an allowlisted package, generated pm-changelog output, publication attestation and packed consumers. Historical function proofs use the source checkout's Git history. Revert tests remove individual safety protections only in disposable copies and require behavioral failures, then rerun restored passing behavior. Tests use real SDK temp trackers and real node:http/HTTPS servers.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | Command completed, including historical comparison violations or an uncertain recorded result; inspect structured verdicts/receipts |
| 2 | Invalid declaration, boundary/private destination refusal, absent credential, unsupported capability or safe SDK failure; read the remedy |
| 3 | Revision conflict; read current context and re-plan/recover |
| 130 | Caller cancellation; no partial observation admitted |
