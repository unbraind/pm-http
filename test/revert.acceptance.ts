import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from '@babel/parser';
import { npmEnvironment } from '../scripts/environment.ts';

const repository = resolve(import.meta.dirname, '..'); const scratch = mkdtempSync(join(tmpdir(), 'http-revert-'));
const scenarios = [
  ['mutation-review', 'policy.ts', 'requestFor', 'mutations require separately', (body: string) => body.replace('mutating(probe) && probe.review?.allowMutation !== true', 'false').replace('if (mutating(probe)) requireInput', 'if (false) requireInput')],
  ['redirect-boundary', 'policy.ts', 'within', 'redirect and credential confinement', (_body: string) => '{}'],
  ['private-destination', 'policy.ts', 'destination', 'redirect and credential confinement', (body: string) => body.replace('answers.some(answer => privateAddress(answer.address)) && !boundary.private', 'false')],
  ['response-bytes', 'transport.ts', 'capture', 'byte/header/time ceilings', (body: string) => body.replace('remainingBytes - size', '1048576 - size')],
  ['response-headers', 'capture.ts', 'captureHeaders', 'byte/header/time ceilings', (body: string) => body.replace('Math.min(raw.length, max * 2)', 'raw.length')],
  ['wall-time', 'transport.ts', 'capture', 'byte/header/time ceilings', (body: string) => body.replace('setTimeout(cancel, probe.timeoutMs)', 'setTimeout(cancel, probe.timeoutMs * 30)')],
  ['cancellation', 'transport.ts', 'capture', 'byte/header/time ceilings', (body: string) => body.replace('if (caller?.aborted) throw', 'if (false) throw')],
  ['redaction', 'capture.ts', 'headerValue', 'random secret placements', (_body: string) => '{ return value; }'],
  ['uncertain-mutation-retry', 'api.ts', 'send', 'mutations require separately', (body: string) => body.replace('observation = await capture(id, probe, options.signal);', 'observation = await capture(id, probe, options.signal); if (observation.outcome === "uncertain") observation = await capture(id, probe, options.signal);')],
  ['inert-rendering', 'core.ts', 'inert', 'data rendering treats instructions', (_body: string) => '{ return value; }'],
  ['conditional-record', 'store.ts', 'change', 'SDK compare-and-set revalidates', (body: string) => body.replace("match: snapshot.item.http_state === undefined ? { key: 'updated_at', value: snapshot.item.updated_at } : { key: 'http_state', value: snapshot.item.http_state }, ", '')],
  ['observation-deduplication', 'api.ts', 'send', 'crash at complete', (body: string) => body.replace("if (existing !== undefined) { requireInput(digest(existing) === digest(final), 'Observation identity already has different evidence'); return false; }", '')],
  ['crash-recovery', 'api.ts', 'send', 'crash at sending', (body: string) => body.replace("if (plan.stage === 'sending') observation = uncertain", 'if (false) observation = uncertain')],
  ['host-error-privacy', 'commands.ts', 'expected', 'literal secrets', (body: string) => body.replace(", recovery: { attempted_command: 'pm http [arguments omitted]', normalized_args: [], provided_fields: [] }", '')],
] as const;
/** Run one real behavioral test file in a disposable copy, never the reviewed checkout. */
function run(root: string, pattern: string, file: string) { const outcome = spawnSync(process.execPath, ['--test', '--test-concurrency=2', '--test-name-pattern', pattern, `test/${file}.test.ts`], { cwd: root, env: npmEnvironment(process.env), encoding: 'utf8', timeout: 180000 }); return { status: outcome.status, output: outcome.stdout + outcome.stderr }; }
try {
  const selectedScenarios = process.argv[2] === undefined ? scenarios : scenarios.filter(([name]) => name === process.argv[2]);
  assert.ok(selectedScenarios.length > 0, 'Requested revert scenario must exist');
  for (const [name, file, functionName, pattern, mutation] of selectedScenarios) {
    const root = join(scratch, name); for (const path of ['src', 'test', 'index.ts', 'package.json']) cpSync(join(repository, path), join(root, path), { recursive: true }); symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir');
    const target = join(root, 'src', file); const source = readFileSync(target, 'utf8'); const parsed = parse(source, { sourceType: 'module', plugins: ['typescript'] });
    let selected: { start?: number | null; end?: number | null } | undefined;
    for (const node of parsed.program.body) {
      const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
      if (declaration?.type === 'FunctionDeclaration' && declaration.id?.name === functionName) selected = declaration.body;
      if (declaration?.type === 'ClassDeclaration') for (const method of declaration.body.body) if (method.type === 'ClassMethod' && method.key.type === 'Identifier' && method.key.name === functionName) selected = method.body;
    }
    assert.ok(selected); const begin = selected.start!; const end = selected.end!;
    const body = source.slice(begin, end); const replaced = mutation(body); assert.notEqual(body, replaced);
    writeFileSync(target, source.slice(0, begin) + replaced + source.slice(end));
    const suite = name === 'host-error-privacy' ? 'commands' : name === 'inert-rendering' || name === 'conditional-record' ? 'models' : 'http'; const outcome = run(root, pattern, suite); assert.equal(outcome.status, 1, `${name} must fail by assertion, not timeout or crash`);
    writeFileSync(target, source); const restored = run(root, pattern, suite); assert.equal(restored.status, 0, `${name} fixed behavior must pass after restoration: ${restored.output}`);
    console.log(`${name}: safety removal fails; restored implementation passes`);
  }
  console.log(`Revert proofs: ${selectedScenarios.length}/${selectedScenarios.length}`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
