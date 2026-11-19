import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('trusted publishing requires the direct-publish allowed action', () => {
  const readme = readFileSync('README.md', 'utf8');
  assert.match(readme, /select `npm publish` under \*\*Allowed actions\*\*/);
  assert.match(readme, /created after September 3, 2026 default to\s+`npm stage publish` only/);
  assert.match(readme, /https:\/\/docs\.npmjs\.com\/trusted-publishers\//);
});

test('documented archive installs guard setup and verify the installed version', t => {
  const readme = readFileSync('README.md', 'utf8').replaceAll('\r\n', '\n');
  const blocks = [...readme.matchAll(/^```sh\n([\s\S]*?)^```$/gm)]
    .map(match => match[1])
    .filter(block => /^[ \t]*(?:tarball=|(?:npm install|bun add) "\$archive")/m.test(block));
  assert.ok(blocks.length > 0, 'The README must document an archive installation');
  const source = mkdtempSync(join(tmpdir(), 'readme-pack-'));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  writeFileSync(join(source, 'package.tgz'), 'synthetic archive');
  writeFileSync(join(source, 'package.json'), '{"version":"1.2.3"}');
  const installed = join(source, 'consumer', 'node_modules', '@unbrained/pm-http');
  mkdirSync(installed, { recursive: true });

  const stubs = String.raw`
scenario=$1
source=$PWD
npm() {
  case "$1" in
    ci) return 0 ;;
    pack)
      printf 'pack\n' >&2
      case "$scenario" in
        pack_failed) printf '%s\n' package.tgz; return 33 ;;
        pack_empty) return 0 ;;
        pack_missing) printf '%s\n' missing.tgz; return 0 ;;
        *) printf '%s\n' package.tgz ;;
      esac
      ;;
    install) install_archive ;;
    *) return 90 ;;
  esac
}
bun() { [ "$1" = add ] && install_archive; }
install_archive() {
  printf 'install\n' >&2
  [ "$PWD" = "$source/consumer" ] && [ "$scenario" != install_failed ]
}
mktemp() {
  printf 'mktemp\n' >&2
  printf '%s\n' "$source/consumer"
  [ "$scenario" != mktemp_failed ]
}
cd() {
  printf 'cd\n' >&2
  [ "$scenario" != cd_failed ] && command cd "$@"
}
npx() { printf 'cli\n' >&2; }
bunx() { printf 'cli\n' >&2; }
`;
  const cases = [
    ['pack_failed', 'pack\n', 1],
    ['pack_empty', 'pack\n', 1],
    ['pack_missing', 'pack\n', 1],
    ['mktemp_failed', 'pack\nmktemp\n', 1],
    ['cd_failed', 'pack\nmktemp\ncd\n', 1],
    ['install_failed', 'pack\nmktemp\ncd\ninstall\n', 1],
    ['version_match', 'pack\nmktemp\ncd\ninstall\n', 0],
    ['version_mismatch', 'pack\nmktemp\ncd\ninstall\n', 1],
  ] as const;
  for (const block of blocks) {
    assert.match(block.trim(), /^\(\n[\s\S]*\n\)$/, 'The archive install must run in a subshell');
    const cliTrace = 'cli\n'.repeat([...block.matchAll(/^\s*(?:npx|bunx) /gm)].length);
    for (const [scenario, trace, status] of cases) {
      const version = scenario === 'version_mismatch' ? '9.9.9' : '1.2.3';
      writeFileSync(join(installed, 'package.json'), JSON.stringify({ version }));
      const result = spawnSync('sh', ['-c', `${stubs}\n${block}\nprintf 'shell continued: %s\\n' "$?"`, 'readme-pack', scenario], {
        cwd: source,
        encoding: 'utf8',
      });
      assert.ifError(result.error);
      const versionCheck = scenario.startsWith('version_');
      const mismatch = scenario === 'version_mismatch' ? 'Expected version 1.2.3, installed 9.9.9.\n' : '';
      assert.equal(result.stderr, trace + (versionCheck ? cliTrace : '') + mismatch, scenario);
      assert.equal(result.status, 0, `${scenario}: the calling shell must continue`);
      assert.equal(result.stdout, `shell continued: ${status}\n`, scenario);
    }
  }
});
