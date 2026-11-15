import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('scoped npm metadata preserves homepage, public access and extension identity', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
  assert.equal(pkg.name, '@unbrained/pm-http');
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(pkg.homepage, 'https://github.com/unbraind/pm-http#readme');
  assert.equal(pkg.publishConfig.access, 'public');
  assert.equal(pkg.pm.catalog.links.npm, 'https://www.npmjs.com/package/@unbrained/pm-http');
  assert.equal(pkg.pm.catalog.display_name, 'pm-http');
  assert.deepEqual(pkg.pm.aliases, ['http']);
  assert.equal(manifest.name, 'pm-http');
  assert.equal(pkg.bin, undefined);
});
