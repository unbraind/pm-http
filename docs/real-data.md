# Real-data proof

Measured 2026-10-29T00:58:16.455Z. Ten explicit read-only requests in a temporary non-git SDK tracker, deleted after the run. Public calls used the unauthenticated GitHub REST repository endpoints for public fleet packages; remaining calls used a synthetic local incident. No credentials were sent. Throttling stops further public calls.

| Measure | Result |
|---|---:|
| Observations | 10 |
| HTTP calls | 10 (2 public, 8 fixture) |
| Captured raw response body bytes | 103388 |
| Raw body estimated tokens (bytes/4, rounded up) | 25847 |
| Difference packet estimated tokens | 817 |
| Packet omitted rows | 0 |
| Header redactions | 90 |
| Total elapsed milliseconds, including SDK setup and recording | 65151 |

Packet costs include the omission receipt and the larger serialized JSON/TOON format. Raw cost includes response bodies only, excluding headers and transcript/request overhead. Body values and keys are never retained. Historical captures are not current health. The incident changes from a successful numeric revision to a failing string revision; the packet identifies the first bad and preceding last good observations. Missing evidence: [{"probe":"pm-evidence","evidence":"complete-response"},{"probe":"pm-hypothesis","evidence":"complete-response"},{"probe":"pending","evidence":"observation"},{"probe":"pending","evidence":"contract"}]. Public schemas wider than 64 properties produce explicit structural omissions.
