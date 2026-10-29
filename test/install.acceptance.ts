import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test, after } from 'node:test';
import { npmEnvironment, gitEnvironment } from '../scripts/environment.ts';
import { server } from './helpers.ts';

const root = await mkdtemp(join(tmpdir(), 'http-packed-')); after(() => rm(root, { recursive: true, force: true }));
const repository = resolve(import.meta.dirname, '..');
const clean = { ...npmEnvironment(gitEnvironment(process.env)), HOME: root, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: root, PM_AUTHOR: 'packed-fixture' };
/** Run a real package manager or installed host without inherited credentials. */
async function execute(cwd: string, executable: string, args: string[], env: NodeJS.ProcessEnv = clean): Promise<string> { return (await promisify(execFile)(executable, args, { cwd, env, timeout: 300000, maxBuffer: 4 * 1048576 })).stdout; }
const packed = JSON.parse(await execute(repository, 'npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root])) as { filename: string; files: { path: string }[] }[];
assert.ok(packed[0].files.every(file => /^(dist\/|manifest\.json$|package\.json$|README\.md$|ARCHITECTURE\.md$|docs\/real-data\.md$|LICENSE$|CHANGELOG\.md$)/.test(file.path)));
const tarball = join(root, packed[0].filename); const hash = createHash('sha256').update(await readFile(tarball)).digest('hex');

for (const manager of ['npm', 'bun']) test(`one packed artifact: ${manager} and ${manager === 'npm' ? 'npx' : 'bunx'} no-git investigation`, async t => {
  let calls = 0; const s = await server(t, (_req, res) => { calls++; res.writeHead(200, { 'content-type': 'application/vnd.api+json' }); res.end('{"ok":true}'); });
  const consumer = join(root, manager); await mkdir(consumer); const env = { ...clean, PM_PATH: join(consumer, '.agents', 'pm') };
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'http-packed-fixture', private: true, type: 'module', dependencies: { 'pm-http': `file:${tarball}`, '@unbrained/pm-cli': '2026.10.28' }, scripts: { http: 'pm http' } }));
  await execute(consumer, manager, ['install', '--ignore-scripts'], env);
  const runner = manager === 'npm' ? 'npx' : 'bunx'; const prefix = manager === 'npm' ? ['--no-install', 'pm'] : ['--bun', '--no-install', 'pm'];
  /** Exercise the actual runner selected by the consumer's package manager. */
  const pm = (args: string[]) => execute(consumer, runner, [...prefix, ...args], env);
  await pm(['init', '--prefix', 'packed', '--defaults', '--agent-guidance', 'skip']); await pm(['config', 'project', 'set', 'agent_identity.probes_enabled', 'false']); await pm(['package', 'install', tarball]);
  const created = JSON.parse(await pm(['create', 'Task', 'Packed API investigation', '--json'])) as { id: string };
  await pm(['http', 'probe', 'add', created.id, 'api', '--url', s.url, '--boundary', s.url]);
  await pm(['http', 'send', created.id, 'api', '--operation', 'packed']);
  await writeFile(join(consumer, 'shape.json'), '{"type":"object","properties":{"ok":{"type":"boolean"}}}');
  await pm(['http', 'contract', 'set', created.id, 'api', '--status', '200', '--json-shape', 'shape.json']);
  const compared = JSON.parse(await execute(consumer, manager, ['run', '--silent', 'http', '--', 'compare', created.id, '--json'], env)) as { comparisons: { result: string }[] };
  assert.equal(compared.comparisons[0].result, 'satisfies');
  assert.ok(Buffer.byteLength(await pm(['http', 'diff', created.id, '--budget', '1500', '--json'])) / 4 <= 1500);
  await writeFile(join(consumer, 'embed.ts'), `import { observations, compare, differencePacket, missingEvidence, addProbe, reviewProbe, send, HttpError } from 'pm-http';
import { PmClient } from '@unbrained/pm-cli/sdk';
import type { State } from 'pm-http';
const item = ${JSON.stringify(created.id)};
const options = { workspace: process.env.PM_PATH! };
if ((await observations(item, options)).observations.length !== 1 || (await compare(item, options)).comparisons[0].result !== 'satisfies' || (await differencePacket(item, options)).estimatedTokens > 1500 || (await missingEvidence(item, options)).missing.length !== 0) throw Error('SDK acceptance failed');
const url = ${JSON.stringify(s.url)};
await addProbe(item, 'guarded', {url,boundary:url,method:'POST'}, options);
await reviewProbe(item, 'guarded', 'Reviewed packed synthetic fixture', options);
const client = new PmClient({pmRoot:options.workspace,noExtensions:true});
const expectedRevision = (await observations(item, options)).revision;
/** Require the installed SDK to refuse before effects. */
async function expectStale(run:()=>Promise<unknown>) { try { await run(); } catch(error) { if(error instanceof HttpError && error.details.reason==='stale_revision')return; throw error; } throw Error('Stale packed request was sent'); }
await expectStale(()=>send(item, 'guarded', {...options,expectedRevision,operationId:'guarded',boundary:async point=>{if(point==='sending')await client.update(item,{title:'Competing packed context'});}}));
await expectStale(()=>send(item,'guarded',{...options,expectedRevision:undefined,operationId:'guard-erased',boundary:async point=>{
if(point!=='sending')return;
const target=await client.get(item,{outputInclude:'full',outputBudget:'unbounded',outputLimit:'unbounded'});
if(!('item' in target))throw Error('Full context unavailable');
const journal=JSON.parse(String(target.item.http_state)) as State; journal.plans.find(plan=>plan.id==='guard-erased')!.stage='cancelled';
await client.update(item,{httpState:JSON.stringify(journal)});
}}));
const snapshot = await client.get(item,{outputInclude:'full',outputBudget:'unbounded',outputLimit:'unbounded'});
if(!('item' in snapshot))throw Error('Full context unavailable');
const value = JSON.parse(String(snapshot.item.http_state)) as State & {legacyPadding?:string}; value.legacyPadding=''; value.legacyPadding='x'.repeat(1048576-4096-Buffer.byteLength(JSON.stringify(value)));
await client.update(item,{httpState:JSON.stringify(value)});
try { await send(item,'api',{...options,operationId:'capacity'});throw Error('Capacity refusal missing'); }
catch(error) { if(!(error instanceof HttpError) || error.code!=='capacity')throw error; }
console.log('SDK accepted');
`);
  assert.match(await execute(consumer, manager === 'npm' ? process.execPath : 'bun', ['embed.ts'], env), /SDK accepted/);
  for (const format of [[], ['--json']]) for (const mode of [[], ['--dry-run']]) await assert.rejects(pm(['http', 'send', created.id, 'api', '--operation', 'cli-capacity', ...mode, ...format]), error => { const output = error as { stdout: string; stderr: string }; assert.match(output.stdout + output.stderr, /capacity/); return true; });
  assert.equal(calls, 1);
  assert.equal(createHash('sha256').update(await readFile(tarball)).digest('hex'), hash);
});
