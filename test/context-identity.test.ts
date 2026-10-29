import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import type { PmClientFullMutationOptions } from '@unbrained/pm-cli/sdk';
import { addProbe, reviewProbe, send, preview, listProbes, observations, compare, differencePacket, missingEvidence, HttpError } from '../index.ts';
import { digest } from '../src/core.ts';
import { Store, targetDigest } from '../src/store.ts';
import { admitPlan } from '../src/api.ts';
import { tracker, server, extension, environment } from './helpers.ts';

/** Accept only a pre-effect stale-context refusal. */
function stale(error: unknown): boolean { return error instanceof HttpError && error.code === 'conflict' && error.details.reason === 'stale_revision'; }

/** Share real non-git context and a counted mutation endpoint across recovery cases. */
async function contextFixture(t: TestContext) {
  const f = await tracker(t); const count = { effects: 0 }; const service = await server(t, (_request, response) => { count.effects++; response.end('{}'); });
  return { ...f, count, service, store: new Store(f.options) };
}

test('native context identity includes every comment independently of text, operation prefix or claimed author', async t => {
  const f = await tracker(t); const original = (await new Store(f.options).read(f.item)).item;
  for (let index = 0; index < 128; index++) {
    const operation = 'operation-' + index; const before = targetDigest(original, operation);
    for (const author of ['fixture', 'peer']) for (const text of [`HTTP operation ${operation}: Authorization withdrawn ${digest(index)}`, `HTTP operation ${operation}: Journaled explicit HTTP send intent`, 'ordinary context ' + digest(index)]) {
      const comment = { created_at: '2026-01-01T00:00:00Z', author, text };
      const changed = { ...original, comments: [...(original.comments ?? []), comment] };
      assert.notEqual(targetDigest(changed, operation), before);
      for (const altered of [{ ...comment, text: text + ' changed' }, { ...comment, author: 'another' }, { ...comment, created_at: '2026-01-02T00:00:00Z' }]) assert.notEqual(targetDigest({ ...changed, comments: [...(original.comments ?? []), altered] }, operation), targetDigest(changed, operation));
    }
  }
});

test('guarded planned recovery refuses every peer comment even when its prefix or author impersonates journal writes', async t => {
  const f = await contextFixture(t); const store = f.store;
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const name = method.toLowerCase(); await addProbe(f.item, name, { url: f.service.url, boundary: f.service.url, method }, f.options); await reviewProbe(f.item, name, 'Reviewed synthetic context identity fixture', f.options);
    for (const author of ['peer', 'fixture']) {
      const operationId = `${name}-${author}`; const expectedRevision = (await store.read(f.item)).value.revision;
      await assert.rejects(send(f.item, name, { ...f.options, operationId, expectedRevision, boundary: point => { if (point === 'planned') throw new HttpError('crash', 'Synthetic planned interruption'); } }), HttpError);
      const text = `HTTP operation ${operationId}: ` + (author === 'peer' ? 'Authorization withdrawn' : 'Journaled explicit HTTP send intent');
      await f.client.comments(f.item, { add: text, author });
      for (const apply of [preview, send]) await assert.rejects(apply(f.item, name, { ...f.options, operationId }), stale);
    }
  }
  assert.equal(f.count.effects, 0); assert.equal((await observations(f.item, f.options)).observations.length, 0);
});

test('native host refuses forged-prefix planned recovery in both formats without git', async t => {
  const f = await contextFixture(t); await extension(f.workspace);
  await addProbe(f.item, 'write', { url: f.service.url, boundary: f.service.url, method: 'POST' }, f.options); await reviewProbe(f.item, 'write', 'Reviewed host withdrawal fixture', f.options);
  for (const format of [[], ['--json']]) {
    const expectedRevision = (await new Store(f.options).read(f.item)).value.revision; const operationId = format.length === 0 ? 'withdrawn-toon' : 'withdrawn-json';
    await assert.rejects(send(f.item, 'write', { ...f.options, expectedRevision, operationId, boundary: point => { if (point === 'planned') throw new HttpError('crash', 'Synthetic host interruption'); } }), HttpError);
    await f.client.comments(f.item, { add: `HTTP operation ${operationId}: Authorization withdrawn`, author: 'peer' });
    for (const mode of [['--dry-run'], []]) await assert.rejects(promisify(execFile)(process.execPath, [join(import.meta.dirname, '../node_modules/.bin/pm'), 'http', 'send', f.item, 'write', '--operation', operationId, ...mode, ...format], { cwd: f.root, env: environment(f.root, f.workspace), timeout: 60000 }), error => {
      const result = error as { code: number; stdout: string; stderr: string }; assert.equal(result.code, 3); assert.match(result.stdout + result.stderr, /Native target changed/); assert.match(result.stdout + result.stderr, /Remedy:/); return true;
    });
  }
  assert.equal(f.count.effects, 0);
});

test('legacy weak-fingerprint guarded plans remain readable and refuse effects; fresh guarded plans resume unchanged', async t => {
  const f = await contextFixture(t); const store = f.store;
  await addProbe(f.item, 'write', { url: f.service.url, boundary: f.service.url, method: 'POST' }, f.options); await reviewProbe(f.item, 'write', 'Reviewed legacy context fixture', f.options);
  const snapshot = await store.read(f.item); const operationId = 'legacy'; const expectedRevision = snapshot.value.revision;
  admitPlan(snapshot.value, snapshot.value.probes[0], operationId, expectedRevision, targetDigest(snapshot.item, operationId)); snapshot.value.revision++;
  const { http_state: _state, updated_at: _updated, collection_counts: _counts, comments, ...content } = snapshot.item;
  snapshot.value.plans[0].targetDigest = digest({ ...content, comments: comments ?? [] });
  await f.client.update(f.item, { httpState: JSON.stringify(snapshot.value), comment: ['HTTP operation legacy: Journaled explicit HTTP send intent'] } as PmClientFullMutationOptions);
  assert.equal((await listProbes(f.item, f.options)).probes.length, 1); assert.equal((await observations(f.item, f.options)).observations.length, 0);
  assert.ok((await compare(f.item, f.options)).receipt.complete); assert.ok((await differencePacket(f.item, f.options)).receipt.sourceComplete); assert.ok((await missingEvidence(f.item, f.options)).receipt.complete);
  for (const apply of [preview, send]) await assert.rejects(apply(f.item, 'write', { ...f.options, operationId }), stale);
  assert.equal(f.count.effects, 0);
  const options = { ...f.options, expectedRevision: (await store.read(f.item)).value.revision, operationId: 'fresh' };
  await assert.rejects(send(f.item, 'write', { ...options, boundary: point => { if (point === 'planned') throw new HttpError('crash', 'Synthetic unchanged interruption'); } }), HttpError);
  assert.equal((await preview(f.item, 'write', { ...f.options, operationId: 'fresh' })).willSend, true);
  assert.equal((await send(f.item, 'write', { ...f.options, operationId: 'fresh' })).observation.status, 200); assert.equal(f.count.effects, 1);
});
