import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { activateExtensionForTest, decodeToon } from '@unbrained/pm-cli/sdk/testing';
import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';
import http from '../index.ts';
import { runCommand } from '../src/commands.ts';
import { environment, extension, server, tracker, contents } from './helpers.ts';

const execute = promisify(execFile);
/** Invoke the real host asynchronously so a real local server can answer. */
async function cli(root: string, workspace: string, args: string[]) { return execute(process.execPath, [join(import.meta.dirname, '../node_modules/.bin/pm'), 'http', ...args], { cwd: root, env: environment(root, workspace), timeout: 60000 }); }

test('real native host runs every command without git, in TOON and JSON', async t => {
  const f = await tracker(t); await extension(f.workspace); let requests = 0;
  const s = await server(t, (_req, res) => { requests++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  const activation = await activateExtensionForTest(http, { capabilities: ['commands', 'schema', 'renderers'] }); assert.equal(activation.failed.length, 0);
  await cli(f.root, f.workspace, ['probe', 'add', f.item, 'api', '--url', s.url, '--boundary', s.url, '--header', 'accept=application/json', '--response-header', 'content-type', '--max-bytes', '1000', '--timeout-ms', '5000', '--max-headers', '32']);
  await cli(f.root, f.workspace, ['probe', 'review', f.item, 'api', '--allow-mutation', '--reason', 'Reviewed local synthetic fixture']);
  await cli(f.root, f.workspace, ['probe', 'list', f.item]);
  await cli(f.root, f.workspace, ['send', f.item, 'api', '--dry-run']); assert.equal(requests, 0);
  await cli(f.root, f.workspace, ['send', f.item, 'api', '--operation', 'host-observation', '--json']); assert.equal(requests, 1);
  const shape = join(f.root, 'shape.json'); await writeFile(shape, '{"type":"object","properties":{"ok":{"type":"boolean"}}}');
  await cli(f.root, f.workspace, ['contract', 'set', f.item, 'api', '--status', '200', '--status', '204', '--json-shape', shape, '--require-header', 'content-type', '--max-latency-ms', '5000']);
  for (const format of [[], ['--json']]) {
    const packet = await cli(f.root, f.workspace, ['diff', f.item, '--budget', '1500', ...format]);
    const parsed = (format.length === 0 ? decodeToon(packet.stdout) : JSON.parse(packet.stdout)) as { receipt: { sourceComplete: boolean } };
    assert.ok(parsed.receipt.sourceComplete); assert.ok(Buffer.byteLength(packet.stdout) / 4 <= 1500);
  }
  await cli(f.root, f.workspace, ['compare', f.item, 'api']); await cli(f.root, f.workspace, ['missing', f.item, '--json']);
  const bounded = JSON.parse((await cli(f.root, f.workspace, ['diff', f.item, '--budget', '256', '--json'])).stdout) as { receipt: { restore: string; missing: string } };
  for (const restore of [bounded.receipt.restore, bounded.receipt.missing]) {
    const restored = await cli(f.root, f.workspace, [...restore.split(' ').slice(2), '--json']); assert.ok(JSON.parse(restored.stdout));
  }
  await assert.rejects(cli(f.root, f.workspace, ['send', f.item, 'api', '--expected-revision', '0']), error => { const actual = error as Error & { code: number; stderr: string }; assert.equal(actual.code, 3); assert.match(actual.stderr, /Remedy:/); assert.ok(!actual.stderr.includes(f.root)); return true; });
});

test('in-process native dispatch validates every optional flag and emits typed remedies', async t => {
  const f = await tracker(t);
  const ctx = { command: 'http', pm_root: f.workspace, args: [f.item, 'api'], options: {}, global: { author: 'fixture' }, sdk: { client: f.client } } as CommandHandlerContext;
  await runCommand('probe add', { ...ctx, args: [f.item, 'minimal'], options: { url: 'https://example.com' } });
  await runCommand('probe add', { ...ctx, options: { url: 'https://example.com', method: 'POST', body: '@HTTP_BODY', boundary: 'https://example.com', header: ['accept=*/*'], responseHeader: 'content-type' } });
  await assert.rejects(runCommand('probe review', ctx), { exitCode: 2 });
  await runCommand('probe review', { ...ctx, options: { allowMutation: true, reason: 'Reviewed explicit synthetic test' } });
  await runCommand('probe list', ctx); await runCommand('send', { ...ctx, options: { dryRun: true } });
  await runCommand('contract set', { ...ctx, options: { status: '200' } });
  await runCommand('compare', { ...ctx, args: [f.item] }); await runCommand('diff', ctx); await runCommand('missing', ctx);
  await assert.rejects(runCommand('unknown', ctx), { exitCode: 2 }); await assert.rejects(runCommand('diff', { ...ctx, args: [] }), { exitCode: 2 });
  await assert.rejects(runCommand('diff', { ...ctx, options: { budget: '' } }), { exitCode: 2 });
  await assert.rejects(runCommand('diff', { ...ctx, options: { expectedRevision: '9999999999999999999999999' } }), { exitCode: 2 });
  await assert.rejects(runCommand('diff', { ...ctx, args: ['absent'] }), { exitCode: 2 });
  const invalid = join(f.root, 'invalid.json'); await writeFile(invalid, 'invalid');
  await assert.rejects(runCommand('contract set', { ...ctx, options: { status: '200', jsonShape: invalid } }), { exitCode: 2 });
  await writeFile(invalid, ' '.repeat(16385)); await assert.rejects(runCommand('contract set', { ...ctx, options: { status: '200', jsonShape: invalid } }), { exitCode: 2 });
});

test('SIGINT through the real host cancels without partial observation', async t => {
  const f = await tracker(t); await extension(f.workspace);
  const s = await server(t, (_req, _res) => { setTimeout(() => process.emit('SIGINT'), 5); });
  const ctx = { command: 'http', pm_root: f.workspace, args: [f.item, 'slow'], options: { url: s.url, boundary: s.url, timeoutMs: '3000' }, global: { author: 'fixture' } } as CommandHandlerContext;
  await runCommand('probe add', ctx);
  await assert.rejects(runCommand('send', { ...ctx, options: { operation: 'signal' } }), { exitCode: 130 });
});

test('native host refuses literal secrets without echoing query, header, userinfo or body bytes', async t => {
  const f = await tracker(t); await extension(f.workspace); const secret = randomBytes(24).toString('hex');
  const declarations = [
    ['--url', `https://example.com/?token=${secret}`],
    ['--url', `https://user:${secret}@example.com/`],
    ['--url', 'https://example.com', '--header', `authorization=${secret}`],
    ['--url', 'https://example.com', '--method', 'POST', '--body', secret],
  ];
  for (const args of declarations) await assert.rejects(cli(f.root, f.workspace, ['probe', 'add', f.item, 'raw', ...args, '--json']), error => {
    const actual = error as { code: number; stdout: string; stderr: string }; assert.equal(actual.code, 2);
    assert.equal((actual.stdout + actual.stderr).includes(secret), false); return true;
  });
  assert.equal((await contents(f.workspace)).includes(secret), false);
});
