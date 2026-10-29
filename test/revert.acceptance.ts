import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from '@babel/parser';
import { npmEnvironment, gitEnvironment } from '../scripts/environment.ts';

const repository = resolve(import.meta.dirname, '..'); const scratch = mkdtempSync(join(tmpdir(), 'http-revert-'));
/** Locate the same named function or method in current and historical TypeScript. */
function functionBody(source: string, name: string): { start: number; end: number } {
  const parsed = parse(source, { sourceType: 'module', plugins: ['typescript'] }); let selected: { start?: number | null; end?: number | null } | undefined;
  for (const node of parsed.program.body) {
    const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
    if (declaration?.type === 'FunctionDeclaration' && declaration.id?.name === name) selected = declaration.body;
    if (declaration?.type === 'ClassDeclaration') for (const method of declaration.body.body) if (method.type === 'ClassMethod' && method.key.type === 'Identifier' && method.key.name === name) selected = method.body;
  }
  assert.ok(selected); const { start, end } = selected; assert.ok(typeof start === 'number' && typeof end === 'number'); return { start, end };
}
/** Revert exactly the previous send function without duplicating its implementation in a fixture. */
function historicalSend(): string {
  let source: string;
  try { source = execFileSync('git', ['show', '560e3de:src/api.ts'], { cwd: repository, env: npmEnvironment(gitEnvironment(process.env)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { throw new Error('Historical revert proof needs the package Git history; run it from a source checkout'); }
  const body = functionBody(source, 'send'); return source.slice(body.start, body.end);
}
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
  ['review-capacity', 'store.ts', 'capacity', 'response admission reserves', (_body: string) => '{}'],
  ['review-revision-admission', 'api.ts', 'send', 'guarded sends retain', (body: string) => body.replaceAll('admitPlan(value, probe, id, options.expectedRevision,', 'admitPlan(value, probe, id, undefined,').replace('if (options.expectedRevision !== undefined && digest', 'if (false && digest').replace('const callerRevision = options.expectedRevision ?? plan.expectedRevision;', 'const callerRevision = plan.expectedRevision;')],
  ['review-revision-send', 'api.ts', 'send', 'guarded sends retain', (body: string) => body.replace('assertPlanGuard(fresh.value, guard, plan, callerRevision, 2, callerRevision === undefined ? undefined : targetDigest(fresh.item, id));', '').replace('if (callerRevision !== undefined) {\n          if (digest(fresh.item)', 'if (false) {\n          if (digest(fresh.item)')],
  ['review-json-family', 'capture.ts', 'jsonMediaType', 'JSON media-family detection', (_body: string) => '{ return false; }'],
  ['review-shape-budget', 'capture.ts', 'bodyShape', 'capacity counts pending slots', (body: string) => body.replaceAll('if (nodes >= 256) { incomplete = true; break; }', '')],
  ['review-legacy-admission', 'api.ts', 'admitPlan', 'legacy planned operations', (body: string) => body.replace("if (previous.stage === 'planned') capacity({ ...value, plans: value.plans.map(plan => plan === previous ? { ...plan, reservedBytes: RESPONSE_RESERVATION } : plan) });", '')],
  ['review-commit-budget', 'api.ts', 'admitPlan', 'preview and reviewed apply agree', (body: string) => body.replace('capacity({ ...value, revision: value.revision + 1 });', 'capacity(value);')],
  ['review-transition-budget', 'api.ts', 'send', 'preview and reviewed apply agree', (body: string) => body.replace('entry.reservedBytes = RESPONSE_RESERVATION - 1024', 'entry.reservedBytes = RESPONSE_RESERVATION')],
  ['review-policy-frame', 'api.ts', 'assertPlanGuard', 'unguarded sends still refuse', (_body: string) => '{}'],
  ['review-original-send', 'api.ts', 'send', 'planned recovery cannot rebase', (_body: string) => historicalSend()],
  ['review-reservation-integrity', 'api.ts', 'assertPlanGuard', 'own recording reservation', (body: string) => body.replace('phase === 2 && entry.reservedBytes !== RESPONSE_RESERVATION - 1024', 'false')],
  ['review-stored-declarations', 'policy.ts', 'storedProbe', 'stored declarations', (_body: string) => '{ return probe; }'],
  ['review-schema-admission', 'api.ts', 'addProbe', 'declaration capacity refuses', (body: string) => body.replace('capacity({ ...current, revision: current.revision + 1 });', '')],
] as const;
/** Run one real behavioral test file in a disposable copy, never the reviewed checkout. */
function run(root: string, pattern: string, file: string) { const outcome = spawnSync(process.execPath, ['--test', '--test-concurrency=2', '--test-name-pattern', pattern, `test/${file}.test.ts`], { cwd: root, env: npmEnvironment(process.env), encoding: 'utf8', timeout: 180000 }); return { status: outcome.status, output: outcome.stdout + outcome.stderr }; }
try {
  const selectedScenarios = process.argv[2] === undefined ? scenarios : scenarios.filter(([name]) => process.argv.slice(2).includes(name));
  assert.ok(selectedScenarios.length > 0, 'Requested revert scenario must exist');
  for (const [name, file, functionName, pattern, mutation] of selectedScenarios) {
    const root = join(scratch, name); for (const path of ['src', 'test', 'index.ts', 'package.json']) cpSync(join(repository, path), join(root, path), { recursive: true }); symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir');
    const target = join(root, 'src', file); const source = readFileSync(target, 'utf8'); const selected = functionBody(source, functionName); const begin = selected.start; const end = selected.end;
    const body = source.slice(begin, end); const replaced = mutation(body); assert.notEqual(body, replaced);
    writeFileSync(target, source.slice(0, begin) + replaced + source.slice(end));
    const suite = ['review-policy-frame', 'review-original-send', 'review-reservation-integrity', 'review-stored-declarations', 'review-schema-admission'].includes(name) ? 'guard-policy' : name.startsWith('review-') ? 'admission' : name === 'host-error-privacy' ? 'commands' : name === 'inert-rendering' || name === 'conditional-record' ? 'models' : 'http'; const outcome = run(root, pattern, suite); assert.equal(outcome.status, 1, `${name} must fail by assertion, not timeout or crash`);
    writeFileSync(target, source); const restored = run(root, pattern, suite); assert.equal(restored.status, 0, `${name} fixed behavior must pass after restoration: ${restored.output}`);
    console.log(`${name}: safety removal fails; restored implementation passes`);
  }
  console.log(`Revert proofs: ${selectedScenarios.length}/${selectedScenarios.length}`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
