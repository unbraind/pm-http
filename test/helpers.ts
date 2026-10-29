import { mkdtemp, rm, readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
import type { RequestListener, Server } from 'node:http';
import type { TestContext } from 'node:test';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { addProbe } from '../index.ts';

/** Create a native SDK tracker outside git, with no mocked SDK methods. */
export async function tracker(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'http-fixture-')); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, '.agents', 'pm'); const client = new PmClient({ pmRoot: workspace, author: 'fixture', noExtensions: true });
  await client.init('fixture', { defaults: true, agentGuidance: 'skip', mergeFence: false });
  await client.config('project', 'set', 'agent_identity.probes_enabled', 'false');
  const created = await client.create({ type: 'Task', title: 'Synthetic API investigation', createMode: 'progressive' });
  return { root, workspace, client, item: created.item.id, options: { workspace, author: 'fixture' } };
}
/** Open a real loopback fixture and always close sockets and server. */
export async function server(t: TestContext, handler: RequestListener) {
  return listen(t, createServer(handler));
}
/** Share listener lifetime management across plain and verified TLS fixtures. */
export async function listen(t: TestContext, instance: Server, scheme = 'http') {
  instance.listen(0, '127.0.0.1'); await new Promise<void>(resolve => { instance.once('listening', resolve); });
  t.after(() => { instance.closeAllConnections(); return new Promise<void>(resolve => { instance.close(() => resolve()); }); });
  const address = instance.address(); if (address === null || typeof address === 'string') throw new Error('Fixture address missing');
  return { instance, url: `${scheme}://127.0.0.1:${address.port}` };
}
/** One shared real JSON probe for independent protocol schedules. */
export async function investigation(t: TestContext) {
  const f = await tracker(t); const count = { calls: 0 };
  const service = await server(t, (_req, res) => { count.calls++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  await addProbe(f.item, 'api', { url: service.url, boundary: service.url }, f.options); return { ...f, count };
}
/** Read every tracker file, including journals and history, to prove secret absence. */
export async function contents(directory: string, durableOnly = false): Promise<string> {
  let text = '';
  for (const entry of await readdir(directory, { withFileTypes: true })) { if (durableOnly && ['runtime', 'locks', 'transactions', 'checkpoints', 'search'].includes(entry.name)) continue; const path = join(directory, entry.name); text += entry.isDirectory() ? await contents(path, durableOnly) : await readFile(path, 'utf8'); }
  return text;
}
/** Install a synthetic extension loader; this is host integration, not an SDK mock. */
export async function extension(workspace: string) {
  const dir = join(workspace, 'extensions', 'pm-http'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'pm-http', version: '2026.10.29', entry: 'entry.js', capabilities: ['commands', 'schema', 'renderers'] }));
  await writeFile(join(dir, 'entry.js'), `export { default } from ${JSON.stringify(new URL('../index.ts', import.meta.url).href)};\n`);
}
/** Ensure no git executable or enclosing repository is available to native command paths. */
export function environment(root: string, workspace: string) { return { PATH: root, PM_PATH: workspace, PM_AUTHOR: 'fixture', GIT_CEILING_DIRECTORIES: dirname(root), NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE }; }
