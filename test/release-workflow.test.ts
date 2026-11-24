/** Contracts owned by callers while the released workflow owns release execution. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { isScalar, parseDocument } from 'yaml';

/** Inputs and permissions the package deliberately passes to the shared transaction. */
interface ReleaseCaller {
  on: { schedule: { cron: string }[]; workflow_dispatch: { inputs: Record<string, { type: string; default: boolean }> } };
  permissions: Record<string, string>;
  jobs: { release: { uses: string; permissions: Record<string, string>; with: Record<string, string | boolean> } };
}

const text = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
const document = parseDocument(text, { uniqueKeys: true });
const caller = document.toJS() as ReleaseCaller;

test('release YAML is valid and delegates to exactly one canonical SHA-pinned job', () => {
  assert.deepEqual(document.errors, []);
  assert.deepEqual(Object.keys(caller.jobs), ['release']);
  assert.match(caller.jobs.release.uses, /^unbraind\/pm-ops\/\.github\/workflows\/daily-release\.yml@[a-f0-9]{40}$/u);
  assert.doesNotMatch(caller.jobs.release.uses, /@0{40}$/u);
  assert.deepEqual(Object.keys(caller.jobs.release).sort(), ['permissions', 'uses', 'with']);
});

test('Dependabot can replace the workflow SHA and canonical tag comment together', () => {
  const pin = document.getIn(['jobs', 'release', 'uses'], true);
  assert.ok(isScalar(pin));
  assert.match(pin.comment ?? '', /^\s*v\d{4}\.\d{2}\.\d{2}(?:-\d+)?\s*$/u);
  const dependabot = parseDocument(readFileSync('.github/dependabot.yml', 'utf8'), { uniqueKeys: true });
  assert.deepEqual(dependabot.errors, []);
  const config = dependabot.toJS() as { updates: { 'package-ecosystem': string; directory: string }[] };
  assert.ok(config.updates.some(update => update['package-ecosystem'] === 'github-actions' && update.directory === '/'));
});

test('caller grants the shared transaction permissions without workflow-level privileges or secrets', () => {
  assert.deepEqual(caller.permissions, {});
  assert.deepEqual(caller.jobs.release.permissions, { contents: 'write', 'pull-requests': 'write', actions: 'write', checks: 'read', 'id-token': 'write', issues: 'write' });
  assert.doesNotMatch(text, /secrets:|NPM_TOKEN|NODE_AUTH_TOKEN/u);
});

test('hourly continuation preserves manual release admission and retirement opt-in', () => {
  assert.deepEqual(caller.on.schedule ?? [], [{"cron":"23 3 * * *"},{"cron":"41 * * * *"}]);
  assert.deepEqual(caller.on.workflow_dispatch.inputs['retire-unpublished'], { description: 'Retire only owned untouched unpublished intent', type: 'boolean', default: false });
  assert.equal(caller.jobs.release.with['reconcile-only'], "${{ (github.event_name == 'schedule' && github.event.schedule == '41 * * * *') || inputs.retire-unpublished == true }}");
  assert.equal(caller.jobs.release.with['retire-unpublished'], "${{ github.event_name == 'workflow_dispatch' && inputs.retire-unpublished == true }}");
});

test('generation, checking and notes explicitly allow empty release sections before shared persistence ships', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  for (const name of ['changelog', 'changelog:full', 'changelog:check', 'release:notes'].filter(name => Object.hasOwn(manifest.scripts, name))) {
    assert.ok(manifest.scripts[name]?.split(/\s+/u).includes('--include-empty'), name);
  }
  for (const name of ['changelog:full', 'changelog:check', 'release:notes']) assert.ok(Object.hasOwn(manifest.scripts, name));
});

test('package changelog entry points retain dependency updates', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  for (const name of ['changelog', 'changelog:full', 'changelog:check', 'release:notes', 'changelog:automation']) {
    const command = manifest.scripts[name] ?? '';
    const delegated = /^npm run (\S+)/u.exec(command)?.[1];
    const optedIn = command.split(/\s+/u).includes('--dependency-updates')
      || (delegated !== undefined && (manifest.scripts[delegated]?.split(/\s+/u).includes('--dependency-updates') ?? false));
    assert.equal(optedIn, true, name);
  }
  for (const [name, command] of Object.entries(manifest.scripts)) {
    if (!/(?:^|[\s;|&])(?:pm-changelog|node\s+scripts\/pm-changelog\.ts)(?:\s|$)/u.test(command)) continue;
    assert.equal(command.split(/\s+/u).includes('--dependency-updates'), true, name);
  }
});

test('package-owned approval and preparation inputs are preserved', () => {
  assert.deepEqual(caller.jobs.release.with, {
  "reconcile-only": "${{ (github.event_name == 'schedule' && github.event.schedule == '41 * * * *') || inputs.retire-unpublished == true }}",
  "retire-unpublished": "${{ github.event_name == 'workflow_dispatch' && inputs.retire-unpublished == true }}",
  "release-enabled": "${{ github.repository == 'unbraind/pm-http' && github.ref == 'refs/heads/main' && vars.PM_RELEASE_APPROVED == 'true' }}"
});
});

// The pinned transaction derives the npm coordinate from the caller's package.json.
test('release caller retains package-derived scoped npm identity', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string };
  assert.equal(pkg.name, '@unbrained/pm-http');
  assert.ok(text.includes(`npm identity is derived from package.json: ${pkg.name}.`));
  assert.equal(caller.jobs.release.with['npm-project-dir'] ?? '.', '.');
  assert.equal(Object.hasOwn(caller.jobs.release.with, 'package-name'), false);
  assert.equal(Object.hasOwn(caller.jobs.release.with, 'npm-publish'), false);
  assert.equal(Object.hasOwn(caller.jobs.release.with, 'bun-verify'), false);
});
