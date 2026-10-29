import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { join } from 'node:path';
import test from 'node:test';
import { addProbe, send, reviewProbe, observations, setContract, compare, HttpError } from '../index.ts';
import { makeProbe, destination } from '../src/policy.ts';
import { capture } from '../src/transport.ts';
import { server, tracker, environment, listen } from './helpers.ts';

test('real transport handles redirect budget, malformed targets, loops, empty HEAD, exact bytes and invalid JSON', async t => {
  const f = await tracker(t); const hits: string[] = [];
  const s = await server(t, (req, res) => {
    const path = req.url!; hits.push(path);
    if (path === '/bad') { res.writeHead(302, { location: 'file:///synthetic' }); res.end(); }
    else if (path === '/backslash') { res.writeHead(302, { location: '/api\\child' }); res.end(); }
    else if (path === '/loop' || path === '/post') { res.writeHead(307, { location: '/loop' }); res.end(); }
    else if (path === '/cap') { res.writeHead(302, { location: '/never' }); res.end('x'.repeat(100)); }
    else if (path === '/one') { res.writeHead(302, { location: '/two' }); res.end('abcdefghijkl'); }
    else if (path === '/two' || path === '/exact') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('abcdefghijklmnop'); }
    else if (path === '/invalid') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{bad'); }
    else if (path === '/no-location') { res.writeHead(302); res.end(); }
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(); }
  });
  for (const name of ['bad', 'backslash', 'loop', 'cap', 'one', 'exact', 'invalid', 'no-location', 'head', 'options', 'post']) await addProbe(f.item, name, { url: `${s.url}/${name}`, boundary: s.url, method: name === 'head' ? 'HEAD' : name === 'options' ? 'OPTIONS' : name === 'post' ? 'POST' : 'GET', maxBytes: ['cap', 'one', 'exact'].includes(name) ? 16 : 1000 }, f.options);
  for (const name of ['bad', 'backslash']) await assert.rejects(send(f.item, name, f.options), error => error instanceof HttpError && error.code === 'redirect');
  await assert.rejects(send(f.item, 'loop', f.options), error => error instanceof HttpError && error.code === 'redirect_limit');
  await reviewProbe(f.item, 'post', 'Reviewed synthetic redirect fixture', f.options); await assert.rejects(send(f.item, 'post', f.options), error => error instanceof HttpError && error.code === 'mutation_redirect');
  const cap = (await send(f.item, 'cap', f.options)).observation; assert.equal(cap.receipt.redirectsOmitted, 1); assert.equal(hits.includes('/never'), false);
  const one = (await send(f.item, 'one', f.options)).observation; assert.equal(one.bytes, 4); assert.ok(one.receipt.bodyTruncated);
  assert.equal((await send(f.item, 'exact', f.options)).observation.receipt.bodyTruncated, false);
  assert.equal((await send(f.item, 'invalid', f.options)).observation.receipt.shapeIncomplete, true);
  assert.equal((await send(f.item, 'no-location', f.options)).observation.status, 302);
  for (const name of ['head', 'options']) { await send(f.item, name, f.options); await setContract(f.item, name, { statuses: [200] }, f.options); assert.equal((await compare(f.item, { ...f.options, probe: name })).comparisons[0].result, 'satisfies'); }
  assert.equal((await observations(f.item, f.options)).observations.length, 7);
});

test('DNS deadline, empty answers and rebinding use a resolver seam, while sockets remain real and pinned', async t => {
  let hits = 0; const s = await server(t, (_req, res) => { hits++; res.end(); }); const url = s.url.replace('127.0.0.1', 'localhost'); const probe = makeProbe('dns', { url, boundary: url, timeoutMs: 20 });
  const timed = await capture('dns-timeout', probe, undefined, async () => new Promise(() => {})); assert.equal(timed.outcome, 'uncertain'); assert.equal(hits, 0);
  const controller = new AbortController(); controller.abort(); await assert.rejects(capture('preabort', probe, controller.signal), error => error instanceof HttpError && error.code === 'cancelled');
  await assert.rejects(destination(new URL(s.url), probe.boundary, async () => []), HttpError);
  const publicProbe = makeProbe('public', { url: 'http://example.com' });
  await assert.rejects(destination(new URL(publicProbe.url), publicProbe.boundary, async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]), error => error instanceof HttpError && error.code === 'private_destination');
  const pinned = await capture('dns-pinned', { ...probe, timeoutMs: 5000 }, undefined, async () => [{ address: '127.0.0.1', family: 4 }]); assert.equal(pinned.status, 200); assert.equal(hits, 1);
});

test('real verified TLS records its available timing phase', async t => {
  const f = await tracker(t); const cert = join(f.root, 'fixture-cert.pem'); const key = join(f.root, 'fixture-key.pem');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { encoding: 'utf8' });
  const instance = createServer({ key: await readFile(key), cert: await readFile(cert) }, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  const { url } = await listen(t, instance, 'https');
  await addProbe(f.item, 'tls', { url, boundary: url }, f.options);
  const script = join(f.root, 'tls.ts'); await writeFile(script, `import { send } from ${JSON.stringify(new URL('../index.ts', import.meta.url).href)}; const result = await send(${JSON.stringify(f.item)}, 'tls', {workspace:process.env.PM_PATH!,author:'fixture'}); if(result.observation.status!==200 || result.observation.timing.tls===undefined) throw Error('TLS evidence missing'); console.log('TLS verified');`);
  const output = await promisify(execFile)(process.execPath, [script], { env: { ...environment(f.root, f.workspace), NODE_EXTRA_CA_CERTS: cert, NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE }, encoding: 'utf8' }); assert.match(output.stdout, /TLS verified/);
});
