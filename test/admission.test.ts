import assert from 'node:assert/strict';
import test from 'node:test';
import type { PmClientFullMutationOptions } from '@unbrained/pm-cli/sdk';
import { acquireLockLease } from '@unbrained/pm-cli/sdk';
import { addProbe, reviewProbe, send, preview, setContract, observations, compare, HttpError } from '../index.ts';
import { admitPlan } from '../src/api.ts';
import { Store, capacity, RESPONSE_RESERVATION, state, targetDigest } from '../src/store.ts';
import { bodyShape, jsonMediaType } from '../src/capture.ts';
import { wire, digest } from '../src/core.ts';
import type { State, Step } from '../src/types.ts';
import { server, tracker, contents, investigation } from './helpers.ts';

/** Fill a real tracker with synthetic legacy context while retaining the declared free byte budget. */
async function fill(store: Store, item: string, remaining: number): Promise<void> {
  await store.change(item, value => { const padded = value as State & { legacyPadding?: string }; padded.legacyPadding = ''; padded.legacyPadding = 'x'.repeat(1048576 - remaining - Buffer.byteLength(JSON.stringify(padded)) - 32); return true; }, 'Synthetic legacy state capacity fixture');
}
/** Recognize a stale send without changing the established public conflict exit category. */
function stale(error: unknown): boolean { return error instanceof HttpError && error.code === 'conflict' && error.details.reason === 'stale_revision'; }

test('response admission reserves capacity before every method and protects all concurrent state writers', async t => {
  const f = await tracker(t); let calls = 0; let hold = false; const arrived = Promise.withResolvers<void>(); const respond = Promise.withResolvers<void>();
  const body = JSON.stringify(Array.from({ length: 64 }, () => Object.fromEntries(Array.from({ length: 64 }, (_, key) => [String(key), { child: 1 }]))));
  const s = await server(t, (_req, res) => { calls++; arrived.resolve(); void (hold ? respond.promise : Promise.resolve()).then(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); }); });
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    await addProbe(f.item, method, { url: s.url, boundary: s.url, method, maxBytes: 1048576 }, f.options);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) await reviewProbe(f.item, method, 'Reviewed synthetic capacity fixture', f.options);
  }
  const store = new Store(f.options); await fill(store, f.item, 4096);
  const before = await contents(f.workspace, true);
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) for (const apply of [preview, send]) await assert.rejects(apply(f.item, method, f.options), error => error instanceof HttpError && error.code === 'capacity');
  assert.equal(calls, 0); assert.equal(await contents(f.workspace, true), before);
  await fill(store, f.item, RESPONSE_RESERVATION + 8192);
  hold = true;
  const pending = send(f.item, 'post', { ...f.options, operationId: 'retained' });
  try {
    await arrived.promise;
    await assert.rejects(fill(store, f.item, 4096), error => error instanceof HttpError && error.code === 'capacity');
  } finally { respond.resolve(); }
  const result = await pending; assert.equal(result.observation.outcome, 'response'); assert.equal(result.observation.status, 200); assert.ok(result.observation.receipt.shapeIncomplete);
  assert.ok(Buffer.byteLength(JSON.stringify(result.observation)) < RESPONSE_RESERVATION / 2);
  await send(f.item, 'post', { ...f.options, operationId: 'retained' });
  assert.equal(calls, 1); assert.equal((await observations(f.item, f.options)).observations.length, 1);
});

test('capacity counts pending slots and UTF-8 bytes; structural result bounds hold for adversarial fanout', () => {
  const value = state(undefined); value.observations = Array.from({ length: 128 }, () => ({} as State['observations'][number])); capacity(value);
  for (const stage of ['planned', 'sending', 'received'] as const) { value.plans = [{ id: 'pending', probe: 'api', probeDigest: 'fixture', stage }]; assert.throws(() => capacity(value), HttpError); }
  for (const stage of ['recorded', 'cancelled'] as const) { value.plans = [{ id: 'done', probe: 'api', probeDigest: 'fixture', stage }]; capacity(value); }
  const unicode = { ...state(undefined), legacyPadding: '🙂'.repeat(300000) }; assert.throws(() => capacity(unicode), HttpError);
  const revision = { ...state(undefined), revision: Number.MAX_SAFE_INTEGER }; capacity(revision);
  revision.plans.push({ id: 'guard', probe: 'api', probeDigest: 'fixture', stage: 'sending' }); assert.throws(() => capacity(revision), HttpError);
  revision.revision -= 2; capacity(revision);
  for (let width = 8; width <= 64; width += 8) {
    const object = Object.fromEntries(Array.from({ length: width }, (_, key) => [String(key), { child: null }]));
    const shaped = bodyShape(Array.from({ length: width }, () => object));
    assert.ok(Buffer.byteLength(JSON.stringify(shaped.shape)) < 32768); assert.equal(shaped.incomplete, width >= 16);
  }
  let chain: unknown = null;
  for (let depth = 0; depth < 13; depth++) chain = Object.fromEntries([['child', chain], ...Array.from({ length: 63 }, (_, key) => [String(key), 1])]);
  assert.ok(Buffer.byteLength(JSON.stringify(bodyShape(chain).shape)) < 32768);
});

test('preview and reviewed apply agree at the exact serialized byte boundary across revision digit growth', async t => {
  const f = await tracker(t); let calls = 0; const s = await server(t, (_req, res) => { calls++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  for (const revision of [8, 9]) for (const offset of [-1, 0, 1]) {
    const item = (await f.client.create({ type: 'Task', title: 'Synthetic exact budget boundary', createMode: 'progressive' })).item.id;
    await addProbe(item, 'api', { url: s.url, boundary: s.url, method: 'POST' }, f.options); await reviewProbe(item, 'api', 'Reviewed exact budget fixture', f.options);
    const snapshot = await new Store(f.options).read(item); const original = snapshot.value as State & { legacyPadding?: string }; original.revision = revision; original.legacyPadding = '';
    const operationId = 'byte-edge'; const simulated = structuredClone(original); admitPlan(simulated, simulated.probes[0], operationId, revision, targetDigest(snapshot.item, operationId)); simulated.revision++;
    original.legacyPadding = 'x'.repeat(1048576 - RESPONSE_RESERVATION - Buffer.byteLength(JSON.stringify(simulated)) + offset);
    await f.client.update(item, { httpState: JSON.stringify(original) } as PmClientFullMutationOptions);
    const options = { ...f.options, operationId, expectedRevision: revision };
    if (offset > 0) for (const apply of [preview, send]) await assert.rejects(apply(item, 'api', options), error => error instanceof HttpError && error.code === 'capacity');
    else { await preview(item, 'api', options); assert.equal((await send(item, 'api', options)).observation.status, 200); }
  }
  assert.equal(calls, 4);
});

test('guarded sends retain caller revision across every pre-effect boundary and native task edits', async t => {
  const f = await tracker(t); let calls = 0; const s = await server(t, (_req, res) => { calls++; res.end('{}'); });
  const legacy = await new Store(f.options).read(f.item); assert.equal(typeof targetDigest(legacy.item, 'legacy'), 'string');
  const withoutComments = { ...legacy.item }; delete withoutComments.comments;
  assert.equal(targetDigest(legacy.item, 'legacy'), targetDigest(withoutComments, 'legacy'));
  await addProbe(f.item, 'api', { url: s.url, boundary: s.url, method: 'POST' }, f.options); await reviewProbe(f.item, 'api', 'Reviewed synthetic revision fixture', f.options);
  const store = new Store(f.options);
  for (const point of ['validated', 'plan-ready', 'planned', 'sending'] as Step[]) for (const native of [false, true]) {
    const expectedRevision = (await store.read(f.item)).value.revision; const operationId = `guard-${point}-${native}`;
    await assert.rejects(send(f.item, 'api', { ...f.options, expectedRevision, operationId, boundary: async step => {
      if (step !== point) return;
      if (native) await f.client.update(f.item, { title: `Competing native edit ${point}` });
      else await store.change(f.item, () => true, 'Synthetic competing HTTP state revision');
    } }), stale);
    const plan = (await store.read(f.item)).value.plans.find(entry => entry.id === operationId);
    if (plan !== undefined) { assert.equal(plan.expectedRevision, expectedRevision); assert.equal(plan.reservedBytes, undefined); }
  }
  assert.equal(calls, 0); assert.equal((await observations(f.item, f.options)).observations.length, 0);
});

test('pre-send re-read checks native edits made after the journal commit without advancing the HTTP revision', async t => {
  const f = await investigation(t); const store = new Store(f.options);
  for (const field of ['state', 'item']) {
    const operationId = 'after-commit-' + field; const expectedRevision = (await store.read(f.item)).value.revision; const injected = new Set<string>();
    await assert.rejects(send(f.item, 'api', { ...f.options, expectedRevision, operationId, onTransition: async event => {
      if (event.transition !== 'committed' || injected.has(field)) return;
      const current = await store.read(f.item); if (current.value.plans.find(plan => plan.id === operationId)?.stage !== 'sending' || injected.has(field)) return;
      injected.add(field);
      if (field === 'state') { current.value.contracts.push({ probe: 'api', statuses: [201], headers: [] }); await f.client.update(f.item, { httpState: JSON.stringify(current.value) } as PmClientFullMutationOptions); }
      else await f.client.update(f.item, { title: 'Native edit after journal commit' });
    } }), stale);
    assert.equal(injected.has(field), true);
  }
  assert.equal(f.count.calls, 0);
});

test('guarded planned recovery preserves native source identity and original caller revision', async t => {
  const f = await investigation(t); const store = new Store(f.options);
  for (const changed of [false, true]) {
    const expectedRevision = (await store.read(f.item)).value.revision; const operationId = changed ? 'changed' : 'unchanged';
    await assert.rejects(send(f.item, 'api', { ...f.options, operationId, expectedRevision, boundary: step => { if (step === 'planned') throw new HttpError('crash', 'Synthetic interruption'); } }), HttpError);
    if (changed) {
      await f.client.update(f.item, { comment: ['Competing native context comment'] } as PmClientFullMutationOptions);
      await assert.rejects(send(f.item, 'api', { ...f.options, operationId, expectedRevision: expectedRevision + 1 }), stale);
      await assert.rejects(send(f.item, 'api', { ...f.options, operationId }), stale);
    } else {
      await send(f.item, 'api', { ...f.options, operationId, expectedRevision }); await send(f.item, 'api', { ...f.options, operationId, expectedRevision });
    }
  }
  assert.equal(f.count.calls, 1);
});

test('a late SDK lease refusal leaves a planned operation recoverable without an uncertain request', async t => {
  const f = await investigation(t); let release = async (): Promise<void> => {};
  try {
    await assert.rejects(send(f.item, 'api', { ...f.options, operationId: 'late-lease', boundary: async point => {
      if (point !== 'planned') return;
      const lease = await acquireLockLease(f.workspace, 'http-' + digest('state:' + f.item), 120, 'peer'); release = () => lease.release();
    } }), error => error instanceof HttpError && error.code === 'conflict');
  } finally { await release(); }
  assert.equal(f.count.calls, 0);
  assert.equal((await send(f.item, 'api', { ...f.options, operationId: 'late-lease' })).observation.outcome, 'response'); assert.equal(f.count.calls, 1);
});

test('legacy planned operations acquire recording capacity before any network effect', async t => {
  const f = await investigation(t); const store = new Store(f.options);
  for (const available of [false, true]) {
    const operationId = available ? 'legacy-room' : 'legacy-full'; const snapshot = await store.read(f.item);
    snapshot.value.plans.push({ id: operationId, probe: 'api', probeDigest: digest(snapshot.value.probes[0]), stage: 'planned' });
    const legacy = snapshot.value as State & { legacyPadding?: string }; legacy.legacyPadding = '';
    legacy.legacyPadding = 'x'.repeat(1048576 - (available ? RESPONSE_RESERVATION + 8192 : 4096) - Buffer.byteLength(JSON.stringify(legacy)));
    await f.client.update(f.item, { httpState: JSON.stringify(legacy) } as PmClientFullMutationOptions);
    if (available) {
      assert.equal((await send(f.item, 'api', { ...f.options, operationId })).observation.outcome, 'response');
      await assert.rejects(send(f.item, 'api', { ...f.options, operationId, expectedRevision: (await store.read(f.item)).value.revision }), stale);
    }
    else for (const apply of [preview, send]) await assert.rejects(apply(f.item, 'api', { ...f.options, operationId }), error => error instanceof HttpError && error.code === 'capacity');
  }
  assert.equal(f.count.calls, 1);
});

test('native writers that bypass reservations are rechecked before the sending transition', async t => {
  const f = await investigation(t); const store = new Store(f.options);
  await assert.rejects(send(f.item, 'api', { ...f.options, operationId: 'native-capacity', boundary: async point => {
    if (point !== 'planned') return;
    const snapshot = await store.read(f.item); const value = snapshot.value as State & { legacyPadding?: string }; value.legacyPadding = '';
    value.legacyPadding = 'x'.repeat(1048576 - 4096 - Buffer.byteLength(JSON.stringify(value)));
    await f.client.update(f.item, { httpState: JSON.stringify(value) } as PmClientFullMutationOptions);
  } }), error => error instanceof HttpError && error.code === 'capacity');
  assert.equal(f.count.calls, 0);
});

test('JSON media-family detection is independent of display redaction, suffix, case, parameters and renderers', async t => {
  const f = await tracker(t); let mime = ''; const s = await server(t, (_req, res) => { res.writeHead(200, { 'content-type': mime }); res.end('{"ok":true}'); });
  for (const name of ['selected', 'hidden']) {
    await addProbe(f.item, name, { url: s.url, boundary: s.url, responseHeaders: name === 'selected' ? ['content-type'] : [] }, f.options);
    await setContract(f.item, name, { statuses: [200], shape: { type: 'object', properties: { ok: { type: 'boolean' } } } }, f.options);
  }
  const opaque = 'syntheticopaquevendor';
  for (const subtype of ['json', 'vnd.api+json', 'hal+json', `${opaque}+json`, `x.${opaque}+json`, 'PROBLEM+JSON']) {
    mime = `Application/${subtype}; charset=utf-8; fixture=${opaque}`;
    for (const name of ['selected', 'hidden']) {
      const row = (await send(f.item, name, f.options)).observation; assert.equal(row.shape?.type, 'object');
      for (const format of ['toon', 'json'] as const) assert.equal(wire(row, format).includes(opaque), false);
    }
  }
  assert.ok((await compare(f.item, f.options)).comparisons.every(row => row.result === 'satisfies'));
  assert.equal((await contents(f.workspace)).includes(opaque), false);
  for (let i = 0; i < 128; i++) assert.equal(jsonMediaType(['Content-Type', `application/vnd.fixture-${i}+json; ignored=opaque`], 1), true);
  for (const type of ['text/json', 'application/notjson', 'application/+json', 'application/x+json-bad', 'application/bad type+json']) assert.equal(jsonMediaType(['content-type', type], 1), false);
  assert.equal(jsonMediaType(['etag', 'opaque', 'content-type', 'application/json'], 1), undefined);
});
