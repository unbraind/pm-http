import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('documented archive installs stop before installation when packing fails or yields no archive', t => {
  const readme = readFileSync('README.md', 'utf8').replaceAll('\r\n', '\n');
  const blocks = [...readme.matchAll(/^```sh\n([\s\S]*?)^```$/gm)]
    .map(match => match[1])
    .filter(block => /^tarball=|^(?:npm install|bun add) "\$archive"/m.test(block));
  assert.ok(blocks.length > 0, 'The README must document an archive installation');
  const source = mkdtempSync(join(tmpdir(), 'readme-pack-'));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  writeFileSync(join(source, 'package.tgz'), 'synthetic archive');

  const stubs = String.raw`
pack_result=$1
npm() {
  case "$1" in
    ci) return 0 ;;
    pack)
      printf 'pack\n' >&2
      case "$pack_result" in
        failed) printf '%s\n' package.tgz; return 33 ;;
        empty) return 0 ;;
        missing) printf '%s\n' missing.tgz; return 0 ;;
      esac
      ;;
    *) printf 'npm %s\n' "$1" >&2; return 90 ;;
  esac
}
bun() { printf 'bun %s\n' "$1" >&2; return 90; }
npx() { printf 'npx\n' >&2; return 90; }
bunx() { printf 'bunx\n' >&2; return 90; }
mkdir() { printf 'mkdir\n' >&2; return 90; }
mktemp() { printf 'mktemp\n' >&2; return 90; }
`;
  for (const block of blocks) {
    for (const packResult of ['failed', 'empty', 'missing']) {
      const result = spawnSync('sh', ['-c', `${stubs}\n${block}`, 'readme-pack', packResult], {
        cwd: source,
        encoding: 'utf8',
      });
      assert.ifError(result.error);
      assert.equal(result.stderr, 'pack\n', `${packResult}: only packing should run\n${block}`);
      assert.equal(result.status, 1, `${packResult}: the snippet must exit with a failure`);
    }
  }
});
