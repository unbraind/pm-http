import assert from 'node:assert/strict';
import test from 'node:test';
import type { PmClientFullMutationOptions } from '@unbrained/pm-cli/sdk';
import { addProbe, reviewProbe, send, preview, listProbes, HttpError } from '../index.ts';
import { Store } from '../src/store.ts';
import { tracker, server, investigation, paddedState, contents } from './helpers.ts';
import type { Probe } from '../src/types.ts';
import { uncertain } from '../src/transport.ts';
import { makeProbe } from '../src/policy.ts';
import { assertPlanGuard } from '../src/api.ts';

/** Admit only a typed stale-guard refusal, never a transport uncertainty after an effect. */
function stale(error: unknown): boolean { return error instanceof HttpError && error.code === 'conflict' && error.details.reason === 'stale_revision'; }

test('caller revision guards survive journal policy erasure at every pre-effect transition', async t => {
  const f = await tracker(t); const calls = { value: 0 }; const fixture = await server(t, (_req, res) => { calls.value++; res.end(); });
  await addProbe(f.item, 'write', { url: fixture.url, boundary: fixture.url, method: 'POST' }, f.options); await reviewProbe(f.item, 'write', 'Reviewed guard policy fixture', f.options);
  const store = new Store(f.options);
  const changes = [['expectedRevision', 'erase'], ['guardRevision', 'erase'], ['targetDigest', 'erase'], ['guardRevision', 'rebase'], ['stage', 'recorded'], ['stage', 'cancelled'], ['id', 'erase'], ['probe', 'erase'], ['probeDigest', 'erase']] as const;
  for (const point of ['planned', 'sending']) for (const [field, alteration] of changes) {
    const expectedRevision = (await store.read(f.item)).value.revision; const operationId = `policy-${point}-${field}-${alteration}`;
    await assert.rejects(send(f.item, 'write', { ...f.options, expectedRevision, operationId, boundary: async boundary => {
      if (boundary !== point) return;
      const current = await store.read(f.item); current.value.revision++; const plan = current.value.plans.find(entry => entry.id === operationId)!; const control = plan as unknown as Record<string, unknown>;
      if (alteration === 'erase') delete control[field]; else control[field] = alteration === 'rebase' ? current.value.revision : alteration;
      await f.client.update(f.item, { httpState: JSON.stringify(current.value) } as PmClientFullMutationOptions);
    } }), stale);
  }
  assert.equal(calls.value, 0);
});

test('unguarded sends still refuse native changes to journal ownership and lifecycle', async t => {
  const f = await tracker(t); let effects = 0; const s = await server(t, (_request, response) => { effects++; response.end(); });
  await addProbe(f.item, 'api', { url: s.url, boundary: s.url, method: 'DELETE' }, f.options); await reviewProbe(f.item, 'api', 'Reviewed lifecycle policy fixture', f.options);
  const store = new Store(f.options);
  for (const point of ['planned', 'sending']) for (const field of ['recorded', 'cancelled', 'id', 'probe', 'probeDigest']) {
    const operationId = `lifecycle-${point}-${field}`;
    await assert.rejects(send(f.item, 'api', { ...f.options, operationId, boundary: async boundary => {
      if (boundary !== point) return;
      const current = await store.read(f.item); const plan = current.value.plans.find(entry => entry.id === operationId)!;
      if (field === 'recorded' || field === 'cancelled') plan.stage = field; else delete (plan as unknown as Record<string, unknown>)[field];
      await f.client.update(f.item, { httpState: JSON.stringify(current.value) } as PmClientFullMutationOptions);
    } }), stale);
  }
  assert.equal(effects, 0);
});

test('planned recovery cannot rebase the stored caller guard by altering journal revision metadata', async t => {
  const f = await tracker(t); let calls = 0; const fixture = await server(t, (_req, res) => { calls++; res.end('{}'); });
  await addProbe(f.item, 'api', { url: fixture.url, boundary: fixture.url, method: 'PATCH' }, f.options); await reviewProbe(f.item, 'api', 'Reviewed recovered policy fixture', f.options);
  const store = new Store(f.options);
  for (const alteration of ['remove', 'rebase', 'partial']) {
    const operationId = 'recovery-' + alteration; const expectedRevision = (await store.read(f.item)).value.revision;
    await assert.rejects(send(f.item, 'api', { ...f.options, operationId, expectedRevision, boundary: boundary => { if (boundary === 'planned') throw new HttpError('crash', 'Synthetic interruption'); } }), HttpError);
    const current = await store.read(f.item); current.value.revision++; const plan = current.value.plans.find(entry => entry.id === operationId)!;
    if (alteration === 'remove') delete plan.guardRevision;
    else if (alteration === 'partial') delete plan.expectedRevision;
    else plan.guardRevision = current.value.revision;
    await f.client.update(f.item, { httpState: JSON.stringify(current.value) } as PmClientFullMutationOptions);
    await assert.rejects(send(f.item, 'api', { ...f.options, operationId }), stale);
  }
  assert.equal(calls, 0);
});

test('planned previews share guard checks and distinguish completed or refused operation identities', async t => {
  const f = await investigation(t); const store = new Store(f.options);
  for (const changed of [false, true]) {
    const operationId = changed ? 'preview-refused' : 'preview-completed'; const expectedRevision = (await store.read(f.item)).value.revision; const options = { ...f.options, operationId, expectedRevision };
    await assert.rejects(send(f.item, 'api', { ...options, boundary: point => { if (point === 'planned') throw new HttpError('crash', 'Synthetic preview interruption'); } }), HttpError);
    if (changed) {
      await f.client.update(f.item, { title: 'Changed preview source' });
      await assert.rejects(preview(f.item, 'api', options), stale); await assert.rejects(send(f.item, 'api', options), stale);
      for (const apply of [preview, send]) await assert.rejects(apply(f.item, 'api', { ...f.options, operationId }), error => error instanceof HttpError && error.code === 'cancelled');
    } else {
      assert.equal((await preview(f.item, 'api', options)).willSend, true);
      assert.equal((await preview(f.item, 'api', { ...f.options, operationId })).willSend, true);
      const current = await store.read(f.item); const original = current.value.plans.find(plan => plan.id === operationId)!;
      for (const field of ['expectedRevision', 'guardRevision'] as const) {
        const erased = structuredClone(original); delete erased[field];
        assert.throws(() => assertPlanGuard(current.value, erased, original, expectedRevision, 1, original.targetDigest), stale);
      }
      await send(f.item, 'api', options);
      assert.equal((await preview(f.item, 'api', options)).willSend, false);
    }
  }
  assert.equal(f.count.calls, 1);
});

test('unguarded mutations revalidate their own recording reservation immediately before effects', async t => {
  const f = await tracker(t); let effects = 0;
  const s = await server(t, (_req, res) => { effects++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(Object.fromEntries(Array.from({ length: 64 }, (_, index) => ['field' + index, true])))); });
  await addProbe(f.item, 'api', { url: s.url, boundary: s.url, method: 'POST' }, f.options); await reviewProbe(f.item, 'api', 'Reviewed reservation integrity fixture', f.options);
  const store = new Store(f.options);
  await assert.rejects(send(f.item, 'api', { ...f.options, operationId: 'erased-reservation', boundary: async boundary => {
    if (boundary !== 'sending') return;
    const current = await store.read(f.item); delete current.value.plans.find(plan => plan.id === 'erased-reservation')!.reservedBytes;
    const value = paddedState(current.value, 4096);
    await f.client.update(f.item, { httpState: JSON.stringify(value) } as PmClientFullMutationOptions);
  } }), stale);
  assert.equal(effects, 0);
  await store.change(f.item, value => { delete (value as unknown as Record<string, unknown>).legacyPadding; return true; }, 'Synthetic reservation fixture reset');
  for (const point of ['planned', 'sending']) {
    const operationId = 'known-result-' + point;
    await assert.rejects(send(f.item, 'api', { ...f.options, operationId, boundary: async boundary => {
      if (boundary !== point) return;
      const current = await store.read(f.item); current.value.plans.find(plan => plan.id === operationId)!.observation = uncertain(operationId, current.value.probes[0], 'Synthetic result already captured');
      await f.client.update(f.item, { httpState: JSON.stringify(current.value) } as PmClientFullMutationOptions);
    } }), stale);
    assert.equal((await store.read(f.item)).value.plans.find(plan => plan.id === operationId)?.observation?.id, operationId);
  }
  assert.equal(effects, 0);
});

test('stored declarations are validated by the shared planner before preview or send effects', async t => {
  const f = await investigation(t); const store = new Store(f.options); const original = (await store.read(f.item)).value.probes[0];
  const cases: ((probe: Probe) => void)[] = [
    probe => { delete (probe as Partial<Probe>).maxBytes; }, probe => { probe.timeoutMs = 0; }, probe => { probe.maxHeaders = 129; }, probe => { probe.method = 'TRACE'; }, probe => { probe.method = 'get'; },
    probe => { probe.headers = { authorization: 'synthetic-inline-value' }; }, probe => { probe.url = original.url + '?token=synthetic-inline-value'; }, probe => { probe.body = 'synthetic-inline-body'; },
    probe => { probe.responseHeaders = Array.from({ length: 33 }, (_, index) => 'x-' + index); }, probe => { probe.responseHeaders = ['Content-Type']; }, probe => { delete (probe as Partial<Probe>).responseHeaders; },
    probe => { probe.boundary.private = 'true' as unknown as boolean; }, probe => { probe.boundary.prefix = ''; }, probe => { probe.boundary.origin = probe.boundary.origin.toUpperCase(); },
    probe => { probe.url = 'http://example.com'; probe.boundary = { origin: 'http://example.com', prefix: '/', private: true }; },
  ];
  for (const corrupt of cases) {
    const current = await store.read(f.item); current.value.probes[0] = structuredClone(original); corrupt(current.value.probes[0]); current.value.revision++;
    await f.client.update(f.item, { httpState: JSON.stringify(current.value) } as PmClientFullMutationOptions);
    assert.equal((await listProbes(f.item, f.options)).probes.length, 1);
    for (const apply of [preview, send]) await assert.rejects(apply(f.item, 'api', f.options), error => error instanceof HttpError && error.code === 'invalid');
  }
  const restored = await store.read(f.item); restored.value.probes[0] = original; await f.client.update(f.item, { httpState: JSON.stringify(restored.value) } as PmClientFullMutationOptions);
  await send(f.item, 'api', f.options); assert.equal(f.count.calls, 1);
});

test('declaration capacity refuses before restoring a removed schema registry entry', async t => {
  const f = await investigation(t); const store = new Store(f.options);
  await store.change(f.item, value => { value.probes = Array.from({ length: 32 }, (_, index) => makeProbe('probe-' + index, { url: 'https://example.com' })); return true; }, 'Synthetic probe count boundary');
  await f.client.schemaRemoveField('http_state', { force: true }); const before = await contents(f.workspace, true);
  await assert.rejects(addProbe(f.item, 'overflow', { url: 'https://example.com' }, f.options), error => error instanceof HttpError && error.code === 'capacity');
  assert.equal(await contents(f.workspace, true), before); assert.equal(f.count.calls, 0);
});
