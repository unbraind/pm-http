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
  const s = await server(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
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
  await pm(['http', 'contract', 'set', created.id, 'api', '--status', '200']);
  const compared = JSON.parse(await execute(consumer, manager, ['run', '--silent', 'http', '--', 'compare', created.id, '--json'], env)) as { comparisons: { result: string }[] };
  assert.equal(compared.comparisons[0].result, 'satisfies');
  assert.ok(Buffer.byteLength(await pm(['http', 'diff', created.id, '--budget', '1500', '--json'])) / 4 <= 1500);
  await writeFile(join(consumer, 'embed.ts'), `import { observations, compare, differencePacket, missingEvidence } from 'pm-http';\nconst item = ${JSON.stringify(created.id)};\nconst options = { workspace: process.env.PM_PATH! };\nif ((await observations(item, options)).observations.length !== 1 || (await compare(item, options)).comparisons[0].result !== 'satisfies' || (await differencePacket(item, options)).estimatedTokens > 1500 || (await missingEvidence(item, options)).missing.length !== 0) throw Error('SDK acceptance failed');\nconsole.log('SDK accepted');\n`);
  assert.match(await execute(consumer, manager === 'npm' ? process.execPath : 'bun', ['embed.ts'], env), /SDK accepted/);
  assert.equal(createHash('sha256').update(await readFile(tarball)).digest('hex'), hash);
});
