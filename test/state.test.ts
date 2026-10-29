import assert from 'node:assert/strict';
import test from 'node:test';
import type { PmClientFullMutationOptions } from '@unbrained/pm-cli/sdk';
import { addProbe, send, observations, HttpError, reviewProbe } from '../index.ts';
import { Store } from '../src/store.ts';
import { makeProbe } from '../src/policy.ts';
import { tracker, server, contents } from './helpers.ts';

test('unchanged recovery re-reads the native target; state ceilings validate before writing', async t => {
  const f = await tracker(t); await addProbe(f.item, 'api', { url: 'https://example.com' }, f.options); const store = new Store(f.options);
  await assert.rejects(store.change(f.item, async () => { const current = await store.read(f.item); current.value.revision++; await f.client.update(f.item, { httpState: JSON.stringify(current.value) } as PmClientFullMutationOptions); return false; }, 'Synthetic unchanged race'), error => error instanceof HttpError && error.code === 'conflict');
  const before = (await store.read(f.item)).value.revision;
  await assert.rejects(store.change(f.item, value => { value.probes = Array.from({ length: 33 }, (_, i) => makeProbe('p' + i, { url: 'https://example.com' })); return true; }, 'Synthetic capacity guard'), HttpError);
  assert.equal((await store.read(f.item)).value.revision, before);
});

test('every recovery revalidates a changed probe and refuses operation reassignment', async t => {
  const f = await tracker(t); const s = await server(t, (_req, res) => { res.end(); });
  for (const name of ['first', 'second']) await addProbe(f.item, name, { url: s.url, boundary: s.url }, f.options);
  await send(f.item, 'first', { ...f.options, operationId: 'owned' });
  await assert.rejects(send(f.item, 'second', { ...f.options, operationId: 'owned' }), HttpError);
  await assert.rejects(send(f.item, 'first', { ...f.options, operationId: 'changed', boundary: async point => { if (point === 'validated') await reviewProbe(f.item, 'first', 'Reviewed changed source fixture', f.options); } }), error => error instanceof HttpError && error.code === 'conflict');
  assert.equal((await observations(f.item, f.options)).observations.length, 1);
});

test('missing tasks and stale guards refuse before schema effects; registry drift never erases saved context', async t => {
  const f = await tracker(t); const before = await contents(f.workspace, true);
  await assert.rejects(addProbe('missing', 'api', { url: 'https://example.com' }, f.options), HttpError);
  await assert.rejects(addProbe(f.item, 'api', { url: 'https://example.com' }, { ...f.options, expectedRevision: 1 }), HttpError);
  assert.ok(await contents(f.workspace, true) === before, 'Invalid targets and stale revisions leave durable schema and item bytes unchanged');
  await addProbe(f.item, 'first', { url: 'https://example.com' }, f.options);
  await f.client.schemaRemoveField('http_state', { force: true });
  const saved = await new Store(f.options).read(f.item); assert.equal(saved.value.probes[0].name, 'first');
  await addProbe(f.item, 'second', { url: 'https://example.com/second' }, f.options);
  assert.equal((await new Store(f.options).read(f.item)).value.probes.length, 2);
});

test('declared source templates are native SDK links and preserve existing link notes', async t => {
  const f = await tracker(t); const url = 'https://example.com/api?token=@HTTP_LINK_TOKEN';
  await f.client.docs(f.item, { add: [`path=${url},scope=project,note=Existing source interpretation`] });
  await addProbe(f.item, 'api', { url }, f.options);
  const result = await f.client.get(f.item, { outputInclude: 'full', outputBudget: 'unbounded', outputLimit: 'unbounded' }); assert.ok('item' in result);
  assert.equal(result.item.docs!.length, 1); assert.equal(result.item.docs![0].path, url); assert.equal(result.item.docs![0].note, 'Existing source interpretation');
});
