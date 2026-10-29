import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import { addProbe, reviewProbe, send, observations, HttpError } from '../index.ts';
import { makeProbe } from '../src/policy.ts';
import { capture, protocolUpgrade } from '../src/transport.ts';
import { wire } from '../src/core.ts';
import { tracker, extension, environment, contents } from './helpers.ts';
import { bounded, wireServer } from './wire-fixture.ts';

test('protocol upgrade variants settle without retaining headers or payloads and release every detached socket', async t => {
  for (const error of [undefined, null, {}, new Error('UnrequestedUpgrade'), { code: 'OTHER' }, { code: 42 }]) assert.equal(protocolUpgrade(error), false);
  assert.equal(protocolUpgrade({ code: 'UnrequestedUpgrade' }), true);
  const s = await wireServer(t);
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) for (const path of ['/idle', '/closed', '/info', '/bare']) {
    const probe = makeProbe('wire', { url: s.url + path, boundary: s.url, method, timeoutMs: 250, maxBytes: 16 });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) probe.review = { allowMutation: true, author: 'fixture', reason: 'Reviewed synthetic transport fixture', at: '2026-01-01T00:00:00Z' };
    const result = await bounded(capture(method + path, probe));
    assert.equal(result.outcome, 'uncertain'); assert.equal(result.retry.automaticRetries, 0); assert.match(result.retry.reason, /upgrade|tunnel/);
    assert.equal(result.bytes, 0); assert.deepEqual(result.headers, {}); assert.ok(result.receipt.shapeIncomplete);
    assert.equal(typeof result.timing.firstByte, 'number');
    for (const format of ['json', 'toon'] as const) assert.equal(wire(result, format).includes(s.secret), false);
  }
  await bounded(Promise.all([...s.sockets].map(socket => new Promise<void>(resolve => { socket.once('close', () => resolve()); }))));
  assert.equal(s.sockets.size, 0); assert.equal(s.calls.length, 28);
});

test('every incomplete response phase settles on close, deadline or cancellation while normal streaming still succeeds', async t => {
  const s = await wireServer(t);
  for (const path of ['/silent', '/only-info', '/partial', '/broken', '/reset']) {
    const result = await bounded(capture(path, makeProbe('phase', { url: s.url + path, boundary: s.url, timeoutMs: 100 })));
    assert.equal(result.outcome, 'uncertain'); assert.equal(result.retry.automaticRetries, 0);
  }
  for (const path of ['/silent', '/only-info', '/partial']) {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    s.instance.once('request', () => { timer = setTimeout(() => controller.abort(), 20); });
    try { await assert.rejects(bounded(capture(path, makeProbe('cancel', { url: s.url + path, boundary: s.url, timeoutMs: 1000 }), controller.signal)), error => error instanceof HttpError && error.code === 'cancelled'); }
    finally { clearTimeout(timer); }
  }
  const normal = await bounded(capture('streaming', makeProbe('normal', { url: s.url + '/slow', boundary: s.url, timeoutMs: 1000 })));
  assert.equal(normal.status, 200); assert.equal(normal.bytes, 2); assert.equal(normal.receipt.bodyTruncated, false);
  assert.throws(() => makeProbe('tunnel', { url: s.url, boundary: s.url, method: 'CONNECT' }), HttpError);
  assert.equal(s.calls.length, 9);
});

test('upgrade uncertainty releases SDK send leases, never retries reviewed mutations and cancellation records no partial result', async t => {
  const f = await tracker(t); const s = await wireServer(t);
  for (const [name, path, method] of [['upgraded', '/idle', 'POST'], ['normal', '/ok', 'GET'], ['silent', '/silent', 'POST']]) {
    await addProbe(f.item, name, { url: s.url + path, boundary: s.url, method, timeoutMs: 250 }, f.options);
    if (method === 'POST') await reviewProbe(f.item, name, 'Reviewed synthetic lifecycle fixture', f.options);
  }
  const options = { ...f.options, operationId: 'upgraded' }; const result = await bounded(send(f.item, 'upgraded', options), 30000);
  assert.equal(result.observation.outcome, 'uncertain'); assert.equal(result.observation.retry.safeToRepeat, false);
  assert.deepEqual((await bounded(send(f.item, 'upgraded', options), 30000)).observation, result.observation); assert.equal(s.calls.length, 1);
  assert.equal((await bounded(send(f.item, 'normal', { ...f.options, operationId: 'after-upgrade' }), 30000)).observation.status, 200);
  const controller = new AbortController(); s.instance.once('request', () => controller.abort());
  await assert.rejects(bounded(send(f.item, 'silent', { ...f.options, operationId: 'cancelled', signal: controller.signal }), 30000), error => error instanceof HttpError && error.code === 'cancelled');
  assert.equal((await observations(f.item, f.options)).observations.length, 2);
  assert.equal((await bounded(send(f.item, 'normal', { ...f.options, operationId: 'after-cancel' }), 30000)).observation.status, 200);
  assert.equal((await observations(f.item, f.options)).observations.length, 3); assert.equal(s.calls.length, 4);
  assert.equal((await contents(f.workspace, true)).includes(s.secret), false);
});

test('real no-git host emits terminal upgrade uncertainty in both formats and exits with its send lease released', async t => {
  const f = await tracker(t); const s = await wireServer(t); await extension(f.workspace);
  await addProbe(f.item, 'upgrade', { url: s.url + '/idle', boundary: s.url, timeoutMs: 250 }, f.options);
  for (const format of [[], ['--json']]) {
    const args = [join(import.meta.dirname, '../node_modules/.bin/pm'), 'http', 'send', f.item, 'upgrade', '--operation', format.length === 0 ? 'toon' : 'json', ...format];
    const result = await promisify(execFile)(process.execPath, args, { cwd: f.root, env: environment(f.root, f.workspace), timeout: 30000 });
    const decoded = (format.length === 0 ? decodeToon(result.stdout) : JSON.parse(result.stdout)) as { observation: { outcome: string; retry: { automaticRetries: number } } };
    assert.equal(decoded.observation.outcome, 'uncertain'); assert.equal(decoded.observation.retry.automaticRetries, 0); assert.equal((result.stdout + result.stderr).includes(s.secret), false);
  }
  assert.equal(s.calls.length, 2); assert.equal((await observations(f.item, f.options)).observations.length, 2);
});

test('verified HTTPS uses the same terminal upgrade handling and retains available TLS timing', async t => {
  const f = await tracker(t); const cert = join(f.root, 'cert.pem'); const key = join(f.root, 'key.pem');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert]);
  const s = await wireServer(t, { key: await readFile(key), cert: await readFile(cert) }); const script = join(f.root, 'tls-upgrade.ts');
  await writeFile(script, `import { capture } from ${JSON.stringify(new URL('../src/transport.ts', import.meta.url).href)};\nimport { makeProbe } from ${JSON.stringify(new URL('../src/policy.ts', import.meta.url).href)};\nimport { bounded } from ${JSON.stringify(new URL('./wire-fixture.ts', import.meta.url).href)};\nconst result=await bounded(capture('tls',makeProbe('tls',{url:${JSON.stringify(s.url + '/idle')},boundary:${JSON.stringify(s.url)},timeoutMs:1000})));\nif(result.outcome!=='uncertain'||result.timing.tls===undefined||!result.retry.reason.includes('upgrade'))throw Error('TLS upgrade lifecycle failed');\nconsole.log(JSON.stringify(result));\n`);
  const result = await promisify(execFile)(process.execPath, [script], { cwd: f.root, env: { ...environment(f.root, f.workspace), NODE_EXTRA_CA_CERTS: cert }, timeout: 30000 });
  assert.equal(result.stdout.includes(s.secret), false); assert.equal(s.calls.length, 1);
});
