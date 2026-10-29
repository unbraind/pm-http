import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { addProbe, send, setContract, observations, differencePacket, missingEvidence } from '../index.ts';

const root = await mkdtemp(join(tmpdir(), 'http-real-data-')); const workspace = join(root, '.agents', 'pm');
const started = performance.now(); let localCalls = 0; let status = 200;
const fixture = createServer((_req, res) => { localCalls++; res.writeHead(status, { 'content-type': 'application/json', 'set-cookie': 'synthetic=discarded', 'x-token': 'synthetic-not-a-credential' }); res.end(JSON.stringify({ ok: status === 200, revision: status === 200 ? 1 : 'broken', padding: 'synthetic fixture body '.repeat(500) })); });
try {
  fixture.listen(0, '127.0.0.1'); await new Promise<void>(resolve => { fixture.once('listening', resolve); });
  const address = fixture.address(); assert.ok(address !== null && typeof address !== 'string'); const url = `http://127.0.0.1:${address.port}`;
  const client = new PmClient({ pmRoot: workspace, author: 'public-proof', noExtensions: true }); await client.init('proof', { defaults: true, agentGuidance: 'skip', mergeFence: false });
  const { item } = await client.create({ type: 'Task', title: 'Public API and synthetic incident investigation', createMode: 'progressive' }); const options = { workspace, author: 'public-proof' };
  for (const name of ['pm-evidence', 'pm-hypothesis']) { await addProbe(item.id, name, { url: `https://api.github.com/repos/unbraind/${name}`, headers: ['accept=application/json'], timeoutMs: 10000 }, options); await setContract(item.id, name, { statuses: [200] }, options); }
  await addProbe(item.id, 'incident', { url: url + '/api', boundary: url + '/api', responseHeaders: ['content-type', 'set-cookie', 'x-token'] }, options);
  await addProbe(item.id, 'pending', { url: 'https://api.github.com/repos/unbraind/pm-memory', headers: ['accept=application/json'] }, options);
  await setContract(item.id, 'incident', { statuses: [200], shape: { type: 'object', properties: { revision: { type: 'number' } } } }, options);
  let publicCalls = 0; let throttled = false;
  for (const name of ['pm-evidence', 'pm-hypothesis']) { if (throttled) break; const result = await send(item.id, name, { ...options, operationId: name }); publicCalls++; assert.equal(result.observation.outcome, 'response'); throttled = [403, 429].includes(result.observation.status!); }
  for (let i = 0; i < 10 - publicCalls; i++) { status = i < 4 ? 200 : 503; await send(item.id, 'incident', { ...options, operationId: `incident-${i}` }); }
  const recorded = (await observations(item.id, options)).observations; const packet = await differencePacket(item.id, options); const missing = await missingEvidence(item.id, options);
  assert.equal(recorded.length, 10); assert.equal(localCalls + publicCalls, 10); assert.ok(packet.estimatedTokens <= 1500);
  const report = { at: new Date().toISOString(), observations: recorded.length, packetTokens: packet.estimatedTokens, packetOmittedRows: packet.receipt.omitted, rawBodyBytes: recorded.reduce((sum, row) => sum + row.bytes, 0), redactions: recorded.reduce((sum, row) => sum + row.receipt.redactions, 0), publicCalls, fixtureCalls: localCalls, calls: localCalls + publicCalls, wallMs: Math.round(performance.now() - started), missing: missing.missing };
  const rawTokens = Math.ceil(report.rawBodyBytes / 4);
  const text = `# Real-data proof\n\nMeasured ${report.at}. Ten explicit read-only requests in a temporary non-git SDK tracker, deleted after the run. Public calls used the unauthenticated GitHub REST repository endpoints for public fleet packages; remaining calls used a synthetic local incident. No credentials were sent. Throttling stops further public calls.\n\n| Measure | Result |\n|---|---:|\n| Observations | ${report.observations} |\n| HTTP calls | ${report.calls} (${report.publicCalls} public, ${report.fixtureCalls} fixture) |\n| Captured raw response body bytes | ${report.rawBodyBytes} |\n| Raw body estimated tokens (bytes/4, rounded up) | ${rawTokens} |\n| Difference packet estimated tokens | ${report.packetTokens} |\n| Packet omitted rows | ${report.packetOmittedRows} |\n| Header redactions | ${report.redactions} |\n| Total elapsed milliseconds, including SDK setup and recording | ${report.wallMs} |\n\nPacket costs include the omission receipt and the larger serialized JSON/TOON format. Raw cost includes response bodies only, excluding headers and transcript/request overhead. Body values and keys are never retained. Historical captures are not current health. The incident changes from a successful numeric revision to a failing string revision; the packet identifies the first bad and preceding last good observations. Missing evidence: ${JSON.stringify(report.missing)}. Public schemas wider than 64 properties produce explicit structural omissions.\n`;
  await writeFile(new URL('../docs/real-data.md', import.meta.url), text); console.log(JSON.stringify({ ...report, rawEstimatedTokens: rawTokens }));
} finally { fixture.closeAllConnections(); await new Promise<void>(resolve => { fixture.close(() => resolve()); }); await rm(root, { recursive: true, force: true }); }
