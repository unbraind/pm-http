import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/** Assert every archived publish operand has explicit local-path semantics. */
function archiveContract(workflow: string): void {
  const commands = [...workflow.matchAll(/^\s*npm publish\s+(\S+)([^\n]*)/gm)]; assert.ok(commands.length > 0);
  for (const [, archive, flags] of commands) { assert.equal(archive, './release-artifact/package.tgz'); assert.match(flags, /--provenance/); assert.match(flags, /--ignore-scripts/); }
}
test('release is manual and approval-gated; npm archives always use explicit local paths', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /New packages stay unreleased until the maintainer approves/); assert.match(workflow, /workflow_dispatch:/);
  assert.equal(/^\s+schedule:/m.test(workflow.split('permissions:')[0]), false); assert.match(workflow, /vars.PM_HTTP_RELEASE_ENABLED == 'true'/);
  archiveContract(workflow); assert.throws(() => archiveContract(workflow.replaceAll('./release-artifact/package.tgz', 'release-artifact/package.tgz')));
  assert.match(workflow, /sha256sum --check --strict/); assert.match(workflow, /registry_integrity_matches/);
});
test('artifact digest rejects mutation of an ignored shipped file before handoff', t => {
  const root = mkdtempSync(join(tmpdir(), 'http-artifact-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const archive = join(root, 'package.tgz'); writeFileSync(archive, 'synthetic archive bytes'); const hash = createHash('sha256').update(readFileSync(archive)).digest('hex');
  const manifest = join(root, 'artifact.sha256'); writeFileSync(manifest, `${hash}  package.tgz\n`);
  execFileSync('sha256sum', ['--check', '--strict', manifest], { cwd: root, stdio: 'pipe' }); writeFileSync(archive, 'changed ignored archive bytes');
  assert.throws(() => execFileSync('sha256sum', ['--check', '--strict', manifest], { cwd: root, stdio: 'pipe' }));
});
