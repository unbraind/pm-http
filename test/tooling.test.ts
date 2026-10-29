/**
 * Behavioral suite for this package's executable tooling.
 *
 * Every script under `scripts/` is measured here through the two channels the
 * coverage gate accepts: importable functions driven in-process, and real
 * child executions of the script entry points. The child runs are the point,
 * not a convenience — `c8` aggregates coverage from descendant processes, so
 * spawning the gates exercises their main wiring under measurement instead of
 * leaving it to unmeasured manual runs.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

import { auditPublishAttestation, runIfMain } from "../scripts/verify-release-publish-attestation.ts";
import { isMainInvocation } from "../scripts/main-invocation.ts";
import { runCoverageGate } from "../scripts/coverage-gate.ts";
import { runDocstringGate } from "../scripts/docstring-gate.ts";
import { gitEnvironment, npmEnvironment } from '../scripts/environment.ts';
import { auditIdentities, runIdentityGate } from "../scripts/identity-gate.ts";
import * as typeContracts from "../src/types.ts";

import fleetConfig from "../eslint.config.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");
const scriptsDirectory = join(repositoryRoot, "scripts");
const scratchBase = mkdtempSync(join(tmpdir(), "pm-http-tooling-"));

/** Run one of this package's scripts as a real child process with captured streams. */
function runScript(name: string, args: readonly string[] = [], cwd: string = repositoryRoot) {
  const outcome = spawnSync(process.execPath, [join(scriptsDirectory, name), ...args], { cwd, encoding: "utf8" });
  assert.equal(outcome.error, undefined);
  return { status: outcome.status, stdout: outcome.stdout, stderr: outcome.stderr };
}

/** Materialize a fixture project below the scratch base from relative file contents. */
function fixtureProject(relativeRoot: string, files: Record<string, string>): string {
  const root = join(scratchBase, relativeRoot);
  for (const name of Object.keys(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, files[name]);
  }
  return root;
}

/** Serialize a fixture manifest carrying one `coverageGate` block. */
function coverageManifest(coverageGate: unknown): string {
  return `${JSON.stringify({ name: "gate-fixture", type: "module", private: true, coverageGate })}\n`;
}

/** Run the coverage gate in-process with captured streams and report status plus lines. */
function capturedGate(root: string, runner?: { executable: string; script: string }) {
  const lines: string[] = [];
  const status = runCoverageGate(root, {
    log: line => lines.push(line),
    error: line => lines.push(line),
    ...(runner === undefined ? {} : { runner }),
  });
  return { status, seen: lines.join("\n") };
}

/** Run the docstring gate in-process with captured streams and report its lines plus exit code. */
function capturedDocstrings(root: string) {
  const lines: string[] = [];
  let exited: number | undefined;
  runDocstringGate({
    root,
    log: line => lines.push(line),
    error: line => lines.push(line),
    exit: code => {
      exited = code;
    },
  });
  return { seen: lines.join("\n"), exited };
}

/** A small fully covered source module shared by the passing gate fixtures. */
const COVERED_SOURCE = [
  "export function add(a: number, b: number): number {",
  "  if (a > 0) return a + b;",
  "  return a - b;",
  "}",
  "",
].join("\n");

/** The test that exercises both branches of the shared source module. */
const COVERED_TEST = [
  'import assert from "node:assert/strict";',
  'import test from "node:test";',
  'import { add } from "../src/covered.ts";',
  'test("both arms", () => {',
  "  assert.equal(add(1, 2), 3);",
  "  assert.equal(add(0, 2), -2);",
  "});",
  "",
].join("\n");

/** A manifest block demanding one hundred percent on every dimension. */
const FULL_THRESHOLDS = {
  sources: ["src"],
  tests: ["test/*.test.ts"],
  thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
};

after(() => rmSync(scratchBase, { recursive: true, force: true }));

/** Isolate fixture Git from the caller's global and system configuration (e.g. commit.gpgsign, init.templateDir). */
function fixtureGitEnvironment(root: string, extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return { ...gitEnvironment(process.env), GIT_CONFIG_GLOBAL: join(root, '.gitconfig-global'), GIT_CONFIG_NOSYSTEM: '1', ...extra };
}

/** Run Git in an isolated fixture with an explicit public test identity. */
function fixtureGit(root: string, args: readonly string[], author = 'noreply@github.com', committer = author): string {
  const result = spawnSync('git', [...args], { cwd: root, encoding: 'utf8', env: fixtureGitEnvironment(root, { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: author, GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: committer }) });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** Create a real repository whose baseline precedes one clean policy commit. */
function identityFixture(name: string): string {
  const root = fixtureProject(name, { 'note.txt': 'baseline\n' });
  fixtureGit(root, ['init', '--initial-branch=main']);
  fixtureGit(root, ['add', 'note.txt']);
  fixtureGit(root, ['commit', '-m', 'Initialize fixture']);
  const baseline = fixtureGit(root, ['rev-parse', 'HEAD']);
  mkdirSync(join(root, '.github'));
  writeFileSync(join(root, '.github/identity-baseline.txt'), `# Baseline\n\n${baseline}\n`);
  writeFileSync(join(root, '.github/approved-git-identities.txt'), '# Public fixture identity\nnoreply@github.com\n');
  fixtureGit(root, ['add', '.github/identity-baseline.txt', '.github/approved-git-identities.txt']);
  fixtureGit(root, ['commit', '-m', 'Record fixture policy']);
  return root;
}

test('the manifest coverage gate owns the full authored scope without exemptions', () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
    coverageGate: { sources: string[]; tests: string[]; thresholds: Record<string, number>; ignore: string[] };
  };
  const { sources, tests, thresholds, ignore } = manifest.coverageGate;
  assert.deepEqual(sources, ['src', 'scripts', 'index.ts', 'eslint.config.ts']);
  assert.deepEqual(tests, ['test/*.test.ts']);
  assert.deepEqual(thresholds, { statements: 100, branches: 100, functions: 100, lines: 100 });
  assert.deepEqual(ignore, []);
});

test('evidence type contracts erase without runtime state', () => {
  assert.deepEqual(Object.keys(typeContracts), []);
});

test("published flat configuration can be consumed directly", () => { assert.ok(Array.isArray(fleetConfig)); });

test('identity policy rejects unapproved authors, committers and newly added home paths', () => {
  const root = identityFixture('identity-dirty');
  assert.deepEqual(auditIdentities(root), []);
  const privatePath = '/' + 'home/' + 'fixture/private';
  writeFileSync(join(root, 'note.txt'), `${privatePath}\n`);
  fixtureGit(root, ['add', 'note.txt']);
  fixtureGit(root, ['commit', '-m', 'Add disallowed fixture data'], 'unknown@example.invalid', 'other@example.invalid');
  const violations = auditIdentities(root);
  assert.equal(violations.length, 3);
  assert.match(violations.join('\n'), /unapproved author identity/);
  assert.match(violations.join('\n'), /unapproved committer identity/);
  assert.match(violations.join('\n'), /added absolute home path/);
  const lines: string[] = [];
  assert.equal(runIdentityGate(root, line => lines.push(line)), 1);
  assert.equal(lines.join('\n').includes(privatePath), false);
  assert.equal(lines.join('\n').includes('unknown@example.invalid'), false);
  writeFileSync(join(root, 'note.txt'), 'Removed private fixture data\n');
  fixtureGit(root, ['add', 'note.txt']);
  fixtureGit(root, ['commit', '-m', 'Remove fixture data']);
  assert.equal(auditIdentities(root).length, 3, 'Historical violations cannot be hidden by a later deletion');
});

test('identity policy fails closed on invalid policy and unavailable baseline history', () => {
  const root = identityFixture('identity-invalid');
  const file = join(root, '.github/identity-baseline.txt');
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, 'invalid\n');
  assert.throws(() => auditIdentities(root), /Invalid identity baseline/);
  writeFileSync(file, 'a'.repeat(40));
  const lines: string[] = [];
  assert.equal(runIdentityGate(root, line => lines.push(line)), 1);
  assert.match(lines[0], /could not be verified/);
  writeFileSync(file, original);
  writeFileSync(join(root, '.github/approved-git-identities.txt'), '# No approved identities\n');
  assert.throws(() => auditIdentities(root), /identity list is empty/);
  rmSync(file);
  assert.equal(runIdentityGate(root, () => undefined), 1);
});

test('identity policy checks side-branch commits and merged additions', () => {
  const root = identityFixture('identity-merge');
  fixtureGit(root, ['switch', '-c', 'side']);
  fixtureGit(root, ['commit', '--allow-empty', '-m', 'Unapproved side commit'], 'unknown@example.invalid');
  fixtureGit(root, ['switch', 'main']);
  fixtureGit(root, ['commit', '--allow-empty', '-m', 'Advance main']);
  fixtureGit(root, ['merge', '--no-ff', '--no-commit', 'side']);
  writeFileSync(join(root, 'note.txt'), '/' + 'Users/' + 'fixture/private\n');
  fixtureGit(root, ['add', 'note.txt']);
  fixtureGit(root, ['commit', '-m', 'Merge side with disallowed fixture data']);
  assert.equal(auditIdentities(root).length, 3);
});

test('identity policy runs as a required CI and release gate', () => {
  const ci = readFileSync(join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.match(ci, /- name: Verify commit identities and private path policy\s+run: npm run identity:check/);
  assert.match(manifest.scripts['release:check'], /npm run identity:check/);
  assert.equal(manifest.scripts['identity:check'], 'node scripts/identity-gate.ts');
  const root = identityFixture('identity-main');
  assert.equal(runScript('identity-gate.ts', [root]).status, 0);
  assert.equal(runScript('identity-gate.ts', [], root).status, 0);
  fixtureGit(root, ['reset', '--hard', 'HEAD~1']);
  // An empty audit range is valid once the policy files are restored locally.
  mkdirSync(join(root, '.github'));
  writeFileSync(join(root, '.github/identity-baseline.txt'), fixtureGit(root, ['rev-parse', 'HEAD']));
  writeFileSync(join(root, '.github/approved-git-identities.txt'), 'noreply@github.com\n');
  assert.deepEqual(auditIdentities(root), []);
  assert.equal(runIdentityGate(root), 0);
});

test('release PR tracking link resolves to an existing epic', () => {
  const workflow = readFileSync(join(repositoryRoot, '.github/workflows/release.yml'), 'utf8');
  const body = workflow.split('\n').find(line => line.includes('--body') && line.includes('Tracking:'));
  assert.ok(body);
  const link = body.match(/https:\/\/github\.com\/unbraind\/pm-http\/blob\/main\/(\.agents\/pm\/epics\/[^)]+\.toon)/);
  assert.ok(link);
  assert.equal(existsSync(join(repositoryRoot, link[1])), true);
});

test('Git includes eval queries while ignoring generated search contents', () => {
  const root = fixtureProject('ignore-search', { '.gitignore': readFileSync(join(repositoryRoot, '.gitignore'), 'utf8') });
  fixtureGit(root, ['init', '--initial-branch=main']);
  const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: root, env: fixtureGitEnvironment(root), input: '.agents/pm/search/eval-queries.json\n.agents/pm/search/index.db\n', encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '.agents/pm/search/index.db');
});

test("entry-point guard answers identity, absence and difference", () => {
  const modulePath = join(scriptsDirectory, "main-invocation.ts");
  const moduleUrl = pathToFileURL(modulePath).href;
  assert.equal(isMainInvocation(["node"], moduleUrl), false);
  assert.equal(isMainInvocation(["node", join(repositoryRoot, "package.json")], moduleUrl), false);
  assert.equal(isMainInvocation(["node", modulePath], moduleUrl), true);
  assert.throws(() => isMainInvocation(["node", join(scratchBase, "absent-entry-script")], moduleUrl));
});

test("docstring gate fails an undocumented tree and names the declaration", () => {
  const root = fixtureProject("docstring-dirty", {
    "package.json": '{"name":"docstring-dirty","type":"module","private":true}\n',
    "src/undocumented.ts": "export function unexplained(value: number): number {\n  return value + 1;\n}\n",
  });
  const outcome = capturedDocstrings(root);
  assert.equal(outcome.exited, 1);
  assert.match(outcome.seen, /docstring-gate: 1 violation\(s\) across 1 file\(s\)/);
  assert.match(outcome.seen, /unexplained/);
});

test("docstring gate passes a documented tree", () => {
  const root = fixtureProject("docstring-clean", {
    "package.json": '{"name":"docstring-clean","type":"module","private":true}\n',
    "src/documented.ts": [
      "/** Compute the arithmetic successor of the operand. */",
      "export function increment(value: number): number {",
      "  return value + 1;",
      "}",
      "",
    ].join("\n"),
  });
  const outcome = capturedDocstrings(root);
  assert.equal(outcome.exited, undefined);
  assert.match(outcome.seen, /docstring-gate: 1 file\(s\), 1 declaration\(s\) documented\./);
});

test("docstring gate runs as main from a repository root argument", () => {
  const root = fixtureProject("docstring-main-dirty", {
    "package.json": '{"name":"docstring-main-dirty","type":"module","private":true}\n',
    "src/undocumented.ts": "export function unexplained(value: number): number {\n  return value + 1;\n}\n",
  });
  const failure = runScript("docstring-gate.ts", [root]);
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /docstring-gate: 1 violation\(s\)/);
});

test("docstring gate defaults to its working directory when run as main", () => {
  const root = fixtureProject("docstring-main-clean", {
    "package.json": '{"name":"docstring-main-clean","type":"module","private":true}\n',
    "src/documented.ts": [
      "/** Compute the arithmetic successor of the operand. */",
      "export function increment(value: number): number {",
      "  return value + 1;",
      "}",
      "",
    ].join("\n"),
  });
  const success = runScript("docstring-gate.ts", [], root);
  assert.equal(success.status, 0);
  assert.match(success.stdout, /docstring-gate: 1 file\(s\)/);
});

test("coverage gate measures repository-root sources at full thresholds", () => {
  const root = fixtureProject("coverage-root-source", {
    "package.json": coverageManifest({ ...FULL_THRESHOLDS, sources: ['.'] }),
    "src/covered.ts": COVERED_SOURCE,
    "test/covered.test.ts": COVERED_TEST,
  });
  const result = capturedGate(root);
  assert.equal(result.status, 0, result.seen);
  assert.match(result.seen, /1 source file\(s\) reported; every threshold met/);
});

test("coverage gate passes a fully covered fixture and leaves the reports", () => {
  const root = fixtureProject("coverage-happy", {
    "package.json": coverageManifest(FULL_THRESHOLDS),
    "src/covered.ts": COVERED_SOURCE,
    "test/covered.test.ts": COVERED_TEST,
  });
  const outcome = capturedGate(root);
  assert.equal(outcome.status, 0);
  assert.match(outcome.seen, /1 source file\(s\) reported; every threshold met\./);
  for (const report of ["coverage-summary.json", "coverage-final.json", "lcov.info"]) {
    assert.ok(existsSync(join(root, "coverage", report)), `${report} must exist after a clean run`);
  }
});

test("coverage gate requires a manifest block and invalidates stale reports", () => {
  const root = fixtureProject("coverage-unconfigured", {
    "package.json": '{"name":"coverage-unconfigured","type":"module","private":true}\n',
  });
  mkdirSync(join(root, "coverage"), { recursive: true });
  writeFileSync(join(root, "coverage", "coverage-summary.json"), "{}");
  const outcome = capturedGate(root);
  assert.equal(outcome.status, 1);
  assert.match(outcome.seen, /no `coverageGate` block/);
  assert.equal(existsSync(join(root, "coverage")), false);
});

test("coverage gate refuses configured source locations it cannot walk", () => {
  const absent = fixtureProject("coverage-absent-source", {
    "package.json": coverageManifest({ ...FULL_THRESHOLDS, sources: ["absent"] }),
  });
  const fileEntry = fixtureProject("coverage-bad-file-source", {
    "package.json": coverageManifest({ ...FULL_THRESHOLDS, sources: ["package.json"] }),
    "src/covered.ts": COVERED_SOURCE,
    "test/covered.test.ts": COVERED_TEST,
  });
  const declarationEntry = fixtureProject("coverage-declaration-source", {
    "package.json": coverageManifest({ ...FULL_THRESHOLDS, sources: ["src/ambient.d.ts"] }),
    "src/ambient.d.ts": "declare const ambient: string;\n",
  });
  const messages = [absent, fileEntry, declarationEntry]
    .map(root => capturedGate(root))
    .map(outcome => {
      assert.equal(outcome.status, 1);
      return outcome.seen;
    })
    .join("\n");
  assert.match(messages, /names absent, which does not exist/);
  assert.match(messages, /names package\.json, which is not a TypeScript source file/);
  assert.match(messages, /names src\/ambient\.d\.ts, which is not a TypeScript source file/);
});

test("coverage gate refuses a source walk that finds nothing", () => {
  const root = fixtureProject("coverage-empty-walk", {
    "package.json": coverageManifest({ ...FULL_THRESHOLDS, sources: ["notes"] }),
    "notes/readme.txt": "nothing authored lives here\n",
  });
  const outcome = capturedGate(root);
  assert.equal(outcome.status, 1);
  assert.match(outcome.seen, /source walk found no files/);
});

test("coverage gate rejects a manifest without complete thresholds or tests", () => {
  const thresholds = fixtureProject("coverage-missing-threshold", {
    "package.json": coverageManifest({
      sources: ["src"],
      tests: ["test/*.test.ts"],
      thresholds: { statements: 100, branches: 100, functions: 100 },
    }),
  });
  const tests = fixtureProject("coverage-missing-tests", {
    "package.json": coverageManifest({
      sources: ["src"],
      tests: [],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    }),
  });
  const messages = [capturedGate(thresholds).seen, capturedGate(tests).seen].join("\n");
  assert.match(messages, /thresholds\.lines is missing or not a number/);
  assert.match(messages, /tests must list at least one test entry/);
});

test("coverage gate fails an unmeasured module on every dimension and drops the reports", () => {
  const root = fixtureProject("coverage-dormant", {
    "package.json": coverageManifest(FULL_THRESHOLDS),
    "src/covered.ts": COVERED_SOURCE,
    "src/dormant.ts": "export function resting(value: number): number {\n  return value * 2;\n}\n",
    "test/covered.test.ts": COVERED_TEST,
  });
  const outcome = capturedGate(root);
  assert.equal(outcome.status, 1);
  for (const dimension of ["statements", "branches", "functions", "lines"]) {
    assert.match(outcome.seen, new RegExp(`${dimension}: [\\d.]+% covered, 100% required`));
  }
  assert.equal(existsSync(join(root, "coverage")), false);
});

test("coverage gate honors skipped directories inside a source tree", () => {
  const root = fixtureProject("coverage-skip-dirs", {
    "package.json": coverageManifest({ ...FULL_THRESHOLDS, skipDirs: ["vendor"] }),
    "src/covered.ts": COVERED_SOURCE,
    "src/vendor/bundled.ts": "export const bundled = 1;\n",
    "test/covered.test.ts": COVERED_TEST,
  });
  const outcome = capturedGate(root);
  assert.equal(outcome.status, 0);
  assert.match(outcome.seen, /every threshold met/);
});

test("coverage gate requires the package entry point next to configured sources", () => {
  const root = fixtureProject("coverage-entry", {
    "package.json": coverageManifest(FULL_THRESHOLDS),
    "src/covered.ts": COVERED_SOURCE,
    "index.ts": [
      'import { add } from "./src/covered.ts";',
      "",
      "/** Compute the entry total for the packed consumer. */",
      "export function entryTotal(): number {",
      "  return add(2, 3);",
      "}",
      "",
    ].join("\n"),
    "test/covered.test.ts": [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { add } from "../src/covered.ts";',
      'import { entryTotal } from "../index.ts";',
      'test("both arms", () => {',
      "  assert.equal(add(1, 2), 3);",
      "  assert.equal(add(0, 2), -2);",
      "});",
      'test("entry", () => { assert.equal(entryTotal(), 5); });',
      "",
    ].join("\n"),
  });
  const outcome = capturedGate(root);
  assert.equal(outcome.status, 0);
  assert.match(outcome.seen, /2 source file\(s\) reported/);
});

test("coverage gate accepts one configured source file without duplicating the entry", () => {
  const root = fixtureProject("coverage-file-entry", {
    "package.json": coverageManifest({ ...FULL_THRESHOLDS, sources: ["index.ts"] }),
    "index.ts": [
      "/** Compute the entry total for the packed consumer. */",
      "export function entryTotal(): number {",
      "  return 5;",
      "}",
      "",
    ].join("\n"),
    "test/entry.test.ts": [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { entryTotal } from "../index.ts";',
      'test("entry", () => { assert.equal(entryTotal(), 5); });',
      "",
    ].join("\n"),
  });
  const outcome = capturedGate(root);
  assert.equal(outcome.status, 0);
  assert.match(outcome.seen, /1 source file\(s\) reported/);
});

test('coverage inventory includes nested authored source modules', () => {
  const root = fixtureProject('coverage-nested-source', {
    'package.json': coverageManifest(FULL_THRESHOLDS),
    'src/nested/covered.ts': COVERED_SOURCE,
    'test/covered.test.ts': COVERED_TEST.replace('../src/covered.ts', '../src/nested/covered.ts'),
  });
  const result = capturedGate(root);
  assert.equal(result.status, 0);
  assert.match(result.seen, /1 source file/);
});

test("coverage gate reports a runner that cannot start", () => {
  const root = fixtureProject("coverage-runner-error", {
    "package.json": coverageManifest(FULL_THRESHOLDS),
    "src/covered.ts": COVERED_SOURCE,
  });
  const outcome = capturedGate(root, { executable: join(root, "absent-reporter-launcher"), script: "c8.js" });
  assert.equal(outcome.status, 1);
  assert.match(outcome.seen, /failed to start the c8 reporter/);
});

test("coverage gate turns a signal-killed runner into a failure exit", () => {
  const root = fixtureProject("coverage-runner-signal", {
    "package.json": coverageManifest(FULL_THRESHOLDS),
    "src/covered.ts": COVERED_SOURCE,
    "kill.ts": 'process.kill(process.pid, "SIGKILL");\n',
  });
  const outcome = capturedGate(root, { executable: process.execPath, script: join(root, "kill.ts") });
  assert.equal(outcome.status, 1);
});

test("coverage gate refuses a silent runner that writes no report", () => {
  const root = fixtureProject("coverage-runner-silent", {
    "package.json": coverageManifest(FULL_THRESHOLDS),
    "src/covered.ts": COVERED_SOURCE,
    "silent.ts": "process.exit(0);\n",
  });
  const outcome = capturedGate(root, { executable: process.execPath, script: join(root, "silent.ts") });
  assert.equal(outcome.status, 1);
  assert.match(outcome.seen, /wrote no coverage summary/);
});

test("coverage gate propagates a failing suite status", () => {
  const root = fixtureProject("coverage-failing-suite", {
    "package.json": coverageManifest(FULL_THRESHOLDS),
    "src/covered.ts": COVERED_SOURCE,
    "test/broken.test.ts": [
      'import test from "node:test";',
      'test("broken", () => { throw new Error("synthetic failure"); });',
      "",
    ].join("\n"),
  });
  const outcome = capturedGate(root);
  assert.equal(outcome.status, 1);
  assert.equal(existsSync(join(root, "coverage")), false);
});

test("coverage gate runs as main from a root argument and from the working directory", () => {
  const argumentRoot = fixtureProject("coverage-main-argument", {
    "package.json": coverageManifest(FULL_THRESHOLDS),
    "src/covered.ts": COVERED_SOURCE,
    "test/covered.test.ts": COVERED_TEST,
  });
  const withArgument = runScript("coverage-gate.ts", [argumentRoot]);
  assert.equal(withArgument.status, 0);
  assert.match(withArgument.stdout, /every threshold met/);

  const workingRoot = fixtureProject("coverage-main-cwd", {
    "package.json": coverageManifest(FULL_THRESHOLDS),
    "src/covered.ts": COVERED_SOURCE,
    "test/covered.test.ts": COVERED_TEST,
  });
  const withoutArgument = runScript("coverage-gate.ts", [], workingRoot);
  assert.equal(withoutArgument.status, 0);
  assert.match(withoutArgument.stdout, /every threshold met/);
});

test("lint gate passes the repository through the canonical policy", () => {
  const outcome = runScript("lint.ts");
  assert.equal(outcome.status, 0);
});

test("duplication gate passes the repository with zero tolerated clones", () => {
  const outcome = runScript("duplication-gate.ts");
  assert.equal(outcome.status, 0);
});

test("publish attestation auditor recognizes attested and bare publishes", () => {
  const attested = auditPublishAttestation([
    { file: "release.yml", text: "run: npm publish --provenance --access public\n" },
  ]);
  assert.equal(attested.recognition.kind, "recognized");
  assert.equal(attested.failures.length, 0);

  const bare = auditPublishAttestation([{ file: "release.yml", text: "run: npm publish\n" }]);
  assert.equal(bare.failures.length, 1);
});

test("publish attestation verifier only runs when it is the process entry", () => {
  const ran = runIfMain(["node", join(repositoryRoot, "package.json")], import.meta.url, repositoryRoot);
  assert.equal(ran, false);
});

test("publish attestation verifier audits the tracked repository as main", () => {
  const outcome = runScript("verify-release-publish-attestation.ts");
  assert.equal(outcome.status, 0);
  assert.ok(outcome.stdout.length > 0);
});
test('identity gate ignores inherited repository selection overrides', () => {
  const root = identityFixture('identity-selection');
  const other = identityFixture('identity-selection-other');
  const env = { ...process.env, GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other, GIT_COMMON_DIR: join(other, '.git'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true', Git_DIR: join(other, '.git'), git_work_tree: other, GiT_CONFIG_COUNT: '1' };
  const result = spawnSync(process.execPath, [join(repositoryRoot, 'scripts/identity-gate.ts'), root], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  writeFileSync(join(root, 'violation.txt'), 'identity');
  fixtureGit(root, ['add', 'violation.txt']);
  fixtureGit(root, ['commit', '-m', 'Unapproved fixture'], 'unapproved@example.invalid');
  assert.equal(spawnSync(process.execPath, [join(repositoryRoot, 'scripts/identity-gate.ts'), root], { env, encoding: 'utf8' }).status, 1);
});

/** Coverage children discard all case variants of inherited runner state. */
test('coverage subprocess filters Windows-style environment spellings', () => {
  const root = fixtureProject('coverage-env', {
    'package.json': coverageManifest(FULL_THRESHOLDS),
    'src/covered.ts': COVERED_SOURCE,
    'test/covered.test.ts': COVERED_TEST,
    'inspect.cjs': "require('node:fs').writeFileSync('child-env.json', JSON.stringify(process.env)); process.exit(1);",
  });
  const keys = ['Node_V8_Coverage', 'node_test_context'];
  const previous = keys.map(key => process.env[key]);
  try {
    for (const key of keys) process.env[key] = 'inherited';
    assert.equal(capturedGate(root, { executable: process.execPath, script: join(root, 'inspect.cjs') }).status, 1);
    const child = JSON.parse(readFileSync(join(root, 'child-env.json'), 'utf8')) as Record<string, string>;
    for (const key of keys) assert.equal(child[key], undefined);
    assert.equal(child.NODE_TEST_CONTEXT, undefined);
  } finally {
    for (const [index, key] of keys.entries()) { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }
  }
});

/** Public path checks recognize Windows casing and both path separators. */
test('identity privacy rejects mixed-case drive and backslash home paths', () => {
  const paths = ['c:' + '\\' + 'uSeRs' + '\\' + 'fixture' + '\\', '\\' + 'HOME' + '\\' + 'fixture', 'D:/' + 'users/' + 'fixture/', '/' + 'ROOT/fixture/'];
  for (const [index, path] of paths.entries()) {
    const root = identityFixture(`identity-portable-${index}`);
    writeFileSync(join(root, 'note.txt'), path);
    fixtureGit(root, ['add', 'note.txt']); fixtureGit(root, ['commit', '-m', 'Portable private fixture']);
    assert.match(auditIdentities(root).join('\n'), /added absolute home path/);
  }
});

/** Optional repository operands must never turn a blank path into the current checkout. */
test('quality CLI repository operands reject empty and whitespace paths', () => {
  for (const script of ['identity-gate.ts', 'docstring-gate.ts', 'coverage-gate.ts']) {
    for (const operand of ['', ' ', '\t\n']) {
      const child = runScript(script, [operand]);
      assert.equal(child.status, 1); assert.match(child.stderr, /nonblank repository root/);
    }
  }
});

/** Embedded callers retain the documented current-directory and logger defaults. */
test('docstring API accepts omitted options', () => {
  assert.doesNotThrow(() => runDocstringGate());
});

/** Repository-relative labels are public text, while absolute homes remain disallowed. */
test('identity privacy distinguishes relative labels from absolute home prefixes', () => {
  const root = identityFixture('identity-relative-label');
  writeFileSync(join(root, 'note.txt'), 'CLI numeric/string/root validation; src/root; docs/home/example; public/Users/guide');
  fixtureGit(root, ['add', 'note.txt']); fixtureGit(root, ['commit', '-m', 'Relative labels fixture']);
  assert.deepEqual(auditIdentities(root), []);
  writeFileSync(join(root, 'note.txt'), '/' + 'root/private');
  fixtureGit(root, ['add', 'note.txt']); fixtureGit(root, ['commit', '-m', 'Absolute fixture']);
  assert.match(auditIdentities(root).join('\n'), /added absolute home path/);
});

/** Environment boundaries remove inherited policy without discarding unrelated values. */
test('npm subprocess policy isolates user configuration case-insensitively', () => {
  const value = npmEnvironment({ PATH: 'safe', npm_config_allow_scripts: 'all', NPM_CONFIG_USERCONFIG: 'private', npm_config_userconfig: 'private' });
  assert.equal(value.PATH, 'safe'); assert.equal(value.npm_config_userconfig, devNull);
  assert.equal(value.NPM_CONFIG_USERCONFIG, undefined); assert.equal(value.npm_config_allow_scripts, undefined);
});
