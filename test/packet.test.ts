import assert from 'node:assert/strict';
import test from 'node:test';
import { addProbe, differencePacket, send, setContract } from '../index.ts';
import { fitOutputEnvelope } from '@unbrained/pm-cli/sdk';
import { guarded, HttpError, wire } from '../src/core.ts';
import { Store } from '../src/store.ts';
import { contents, server, tracker } from './helpers.ts';

/** Independently measure the final public packet, including its accounting and newline. */
function costs(packet: unknown) {
  return Object.fromEntries((['json', 'toon'] as const).map(format => [format, Buffer.byteLength(wire(packet, format) + '\n')]));
}

test('packet exact bytes include both final renderers, digests, Unicode and all receipts', async t => {
  const f = await tracker(t); let status = 200;
  const s = await server(t, (_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(status === 200 ? '{"revision":1}' : '{"revision":"changed"}'); });
  await addProbe(f.item, 'api', { url: s.url, boundary: s.url }, f.options);
  await setContract(f.item, 'api', { statuses: [200] }, f.options);
  await send(f.item, 'api', { ...f.options, operationId: 'good' }); status = 503;
  await send(f.item, 'api', { ...f.options, operationId: 'bad' });
  const store = new Store(f.options);
  await store.change(f.item, value => { value.observations[1].retry.reason = 'é漢字🙂<data>\n'.repeat(9); return true; }, 'Synthetic Unicode legacy evidence');
  const before = await contents(f.workspace, true);
  const packet = await differencePacket(f.item, f.options);
  const measured = costs(packet);
  assert.deepEqual(Reflect.get(packet, 'bytes'), measured, 'packet exposes exact JSON and TOON UTF-8 bytes');
  assert.equal(packet.estimatedTokens, Math.ceil(Math.max(...Object.values(measured)) / 4));
  const fit = Reflect.get(packet, 'output_fit');
  assert.equal(fit.output_bytes, Math.max(...Object.values(measured)));
  assert.equal(fit.estimated_tokens, packet.estimatedTokens); assert.equal(fit.policy, 'skip');
  assert.equal(packet.receipt.omitted, 0); assert.equal(packet.receipt.returned, packet.rows.length);
  assert.equal(Reflect.get(packet.receipt, 'budgetUnit'), 'heuristic-units');
  assert.match(JSON.stringify(packet), /[a-f0-9]{64}/); assert.match(JSON.stringify(packet), /漢字/);
  assert.equal(await contents(f.workspace, true), before, 'fitting is read-only');
});

test('SDK packet fitting retains later small rows after an oversized row and counts omissions exactly', async t => {
  const f = await tracker(t);
  await addProbe(f.item, 'large', { url: 'https://example.com' }, f.options);
  await addProbe(f.item, 'small', { url: 'https://example.com' }, f.options);
  let changed = false;
  const s = await server(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field${i}`, changed ? 'changed' : i])))); });
  const store = new Store(f.options);
  await store.change(f.item, value => { value.probes[0].url = s.url + '/'; value.probes[0].boundary = { origin: s.url, prefix: '/', private: true }; return true; }, 'Synthetic local probe declaration');
  await setContract(f.item, 'large', { statuses: [200] }, f.options);
  await send(f.item, 'large', { ...f.options, operationId: 'before' }); changed = true;
  await send(f.item, 'large', { ...f.options, operationId: 'after' });
  const full = await differencePacket(f.item, f.options);
  const bounded = await differencePacket(f.item, { ...f.options, budget: 400 });
  assert.deepEqual(Reflect.get(bounded, 'bytes'), costs(bounded));
  const fit = Reflect.get(bounded, 'output_fit');
  assert.equal(fit.total_candidates, full.rows.length);
  assert.equal(fit.omitted_count, full.rows.length - bounded.rows.length);
  assert.equal(bounded.receipt.omitted, fit.omitted_count);
  assert.deepEqual(bounded.rows, fit.included_indices.map((index: number) => full.rows[index]));
  assert.ok(bounded.estimatedTokens <= 400);
  assert.ok(fit.included_indices.includes(full.rows.length - 1));
  assert.ok(!fit.included_indices.includes(full.rows.length - 2)); assert.equal(bounded.receipt.sourceComplete, true);
});

test('empty minimum receipts and decimal byte boundaries remain exact with bounded whole rows', async t => {
  const f = await tracker(t);
  const empty = await differencePacket(f.item, { ...f.options, budget: 256 });
  assert.deepEqual(Reflect.get(empty, 'bytes'), costs(empty)); assert.deepEqual(empty.rows, []);
  assert.equal(empty.receipt.omitted, 0); assert.equal(empty.receipt.returned, 0);
  assert.ok(empty.estimatedTokens <= 256);
  for (let i = 0; i < 20; i++) await addProbe(f.item, `probe${i}`, { url: 'https://example.com' }, f.options);
  const full = await differencePacket(f.item, { ...f.options, budget: 9999 });
  assert.ok(full.estimatedTokens >= 1000 && full.estimatedTokens < 9999);
  const exact = await differencePacket(f.item, { ...f.options, budget: full.estimatedTokens });
  const smaller = await differencePacket(f.item, { ...f.options, budget: full.estimatedTokens - 1 });
  assert.equal(exact.receipt.omitted, 0); assert.ok(smaller.receipt.omitted > 0);
  for (const packet of [full, exact, smaller]) {
    assert.deepEqual(Reflect.get(packet, 'bytes'), costs(packet));
    assert.equal(packet.estimatedTokens, Math.ceil(Math.max(...Object.values(costs(packet))) / 4));
  }
});


test('actual SDK infeasible and work-limit refusals remain typed and actionable', async t => {
  const f = await tracker(t); const packet = await differencePacket(f.item, f.options);
  const renderers = { json: (value: unknown) => wire(value, 'json') + '\n', toon: (value: unknown) => wire(value, 'toon') + '\n' };
  for (const [code, controls] of [
    ['output_envelope_infeasible', { tokenBudget: 1 }],
    ['output_envelope_work_limit', { tokenBudget: 1500, maxRenderCalls: 1 }],
    ['output_envelope_unstable', { tokenBudget: 1500, maxStabilizationPasses: 1 }],
  ] as const) {
    await assert.rejects(guarded(async () => fitOutputEnvelope([], { ...controls, buildEnvelope: () => packet, renderers }))(), error => {
      assert.ok(error instanceof HttpError); assert.equal(error.code, code);
      assert.match(error.remedy, code === 'output_envelope_infeasible' ? /Increase --budget/ : /complete evidence/);
      assert.equal(error.message.includes(f.root), false); return true;
    });
  }
});
