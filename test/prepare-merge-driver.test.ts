/**
 * Tests for the npm `prepare` hook `scripts/prepare-merge-driver.ts`.
 *
 * The hook preserves the canonical pm-ops installer behavior and is
 * exercised the way npm runs it: as the entry point of a child process whose
 * working directory is a consumer checkout. Every checkout is a fresh
 * `git init` with its own local config, so the drivers this repository's own
 * `npm ci` registered cannot mask a launcher that registers none.
 */
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { after } from "node:test";
import { gitEnvironment } from "../scripts/environment.ts";

// npm runs tests from the package root, which is also where it runs `prepare`.
const root = process.cwd();
const launcher = join(root, "scripts", "prepare-merge-driver.ts");
const hostPath = `${join(root, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`;
const scratch = mkdtempSync(join(tmpdir(), "prepare-merge-driver-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// The fixtures use POSIX stub executables and directory symlinks, like pm-ops's own launcher suite.
const posixOnly = { skip: process.platform === "win32" };

/** Every merge driver `.gitattributes` asks Git to use, e.g. `pm-history` from `merge=pm-history`. */
const declaredDrivers = [
  ...new Set([...readFileSync(join(root, ".gitattributes"), "utf8").matchAll(/\bmerge=([\w-]+)/g)].map((match) => match[1])),
].filter(name => name !== 'text').sort();

/**
 * Create a consumer checkout: a fresh Git repository carrying this
 * repository's `.gitattributes` and tracker settings. `pmOps` selects what
 * `node_modules/pm-ops` is: absent (an omit-dev install), the pinned package,
 * or a stale pm-ops whose exports predate the launcher entry.
 */
function checkout(name: string, pmOps: "absent" | "pinned" | "stale"): string {
  const directory = join(scratch, name);
  mkdirSync(join(directory, ".agents", "pm"), { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: directory, env: gitEnvironment(process.env) }).status, 0);
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name, type: "module" }));
  copyFileSync(join(root, ".gitattributes"), join(directory, ".gitattributes"));
  copyFileSync(join(root, ".agents", "pm", "settings.json"), join(directory, ".agents", "pm", "settings.json"));
  if (pmOps === "pinned") {
    mkdirSync(join(directory, "node_modules"));
    symlinkSync(join(root, "node_modules", "pm-ops"), join(directory, "node_modules", "pm-ops"), "dir");
  }
  if (pmOps === "stale") {
    mkdirSync(join(directory, "node_modules", "pm-ops"), { recursive: true });
    writeFileSync(
      join(directory, "node_modules", "pm-ops", "package.json"),
      JSON.stringify({ name: "pm-ops", type: "module", exports: { "./merge-driver": "./merge-driver.js" } }),
    );
  }
  return directory;
}

/** Put a stub `pm` that runs `body` then exits with `status` alone on a fresh PATH directory. */
function stubPm(name: string, status: number, body = ""): string {
  const bin = join(scratch, `${name}-bin`);
  mkdirSync(bin);
  writeFileSync(join(bin, "pm"), `#!/bin/sh\n${body}\nexit ${status}\n`);
  chmodSync(join(bin, "pm"), 0o755);
  return bin;
}

/**
 * Run the launcher as npm's `prepare` hook would: as the entry point, from `cwd`, with `path` as PATH.
 *
 * @param cwd - Consumer checkout whose Git config the hook may change.
 * @param path - PATH used to resolve `pm`.
 * @param extraEnv - Lifecycle variables such as `npm_command`.
 */
function prepare(cwd: string, path: string, extraEnv: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [launcher], { cwd, encoding: "utf8", env: { ...gitEnvironment(process.env), PATH: path, PM_PATH: join(cwd, ".agents", "pm"), ...extraEnv } });
}

/** The merge drivers registered in a checkout's LOCAL Git config, by name. */
function registeredDrivers(cwd: string): string[] {
  const config = spawnSync("git", ["config", "--local", "--name-only", "--get-regexp", "^merge\\..*\\.driver$"], {
    cwd,
    env: gitEnvironment(process.env),
    encoding: "utf8",
  });
  // git exits 1 when no key matches, which is a genuine "none registered".
  assert.ok(config.status === 0 || config.status === 1, config.stderr);
  return config.stdout.split("\n").filter(Boolean).map((key) => key.split(".")[1]!).sort();
}

test("a full install registers every merge driver .gitattributes declares", posixOnly, () => {
  const directory = checkout("full", "pinned");
  assert.deepEqual(registeredDrivers(directory), []);
  const result = prepare(directory, hostPath);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(join(directory, ".agents", "pm")));
  assert.ok(declaredDrivers.length > 0, ".gitattributes declares no pm merge drivers");
  assert.deepEqual(registeredDrivers(directory), declaredDrivers);
});

test("an omit-dev checkout without pm-ops skips with one notice and registers nothing", posixOnly, () => {
  const directory = checkout("omit-dev", "absent");
  const result = prepare(directory, hostPath);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "pm-ops is not installed (omit-dev install); skipping merge-driver install\n");
  assert.deepEqual(registeredDrivers(directory), []);
});

test("a pm-ops too old to export the launcher entry fails the install", posixOnly, () => {
  const result = prepare(checkout("stale", "stale"), hostPath);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
});

test("an incomplete pm-ops directory fails instead of skipping merge-driver installation", () => {
  const directory = checkout("incomplete", "absent");
  mkdirSync(join(directory, "node_modules", "pm-ops"), { recursive: true });
  const result = prepare(directory, hostPath);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MODULE_NOT_FOUND/);
  assert.doesNotMatch(result.stderr, /skipping merge-driver install/);
});

test("a failing pm merge install fails the install with the same status", posixOnly, () => {
  const result = prepare(checkout("failing-pm", "pinned"), stubPm("failing-pm", 7));
  assert.equal(result.status, 7, result.stderr);
});

test("an installer killed by a signal fails the install instead of reporting success", posixOnly, () => {
  // The stub's parent is the pm-ops installer process the launcher spawned.
  const result = prepare(checkout("killed", "pinned"), stubPm("killed", 0, "kill -9 $PPID"));
  assert.equal(result.status, 1, result.stderr);
});

test("a malformed lookup path preserves the original installer failure", () => {
  const directory = checkout("malformed-lookup", "absent");
  writeFileSync(join(directory, "node_modules"), "not a directory\n");
  const result = prepare(directory, hostPath);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MODULE_NOT_FOUND/);
  assert.doesNotMatch(result.stderr, /ENOTDIR|skipping merge-driver install/);
});

for (const command of ["pack", "publish"]) {
  test(`npm ${command} prepare leaves git config byte-identical and prints one notice`, posixOnly, () => {
    const directory = checkout(`artifact-${command}`, "pinned");
    const config = join(directory, ".git", "config");
    const before = readFileSync(config);
    const result = prepare(directory, hostPath, { npm_command: command });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, `npm ${command}: skipping merge-driver install during artifact creation\n`);
    assert.equal(result.stderr.split("skipping merge-driver install").length - 1, 1);
    assert.deepEqual(readFileSync(config), before);
    assert.deepEqual(registeredDrivers(directory), []);
  });
}

/** Caller environment overrides reach the launcher and its child without touching another tracker. */
test("prepare forwards an explicit tracker override", posixOnly, () => {
  const directory = checkout("override", "pinned");
  const path = stubPm("override", 0, 'printf "%s\\n" "$PM_PATH"');
  const expected = join(directory, "alternate-tracker");
  const result = prepare(directory, path, { PM_PATH: expected });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), expected);
});

/** Poisoned hook variables must never redirect fixture commands to the caller repository. */
test("fixture Git commands ignore inherited repository overrides", posixOnly, () => {
  const decoy = checkout("decoy", "absent");
  const before = readFileSync(join(decoy, ".git", "config"));
  const poison = { GIT_DIR: join(decoy, ".git"), GIT_WORK_TREE: decoy, GIT_INDEX_FILE: join(decoy, "alternate-index") };
  const previous = Object.fromEntries(Object.keys(poison).map(key => [key, process.env[key]]));
  Object.assign(process.env, poison);
  try {
    const directory = checkout("poisoned", "pinned");
    assert.deepEqual(registeredDrivers(directory), []);
    const result = prepare(directory, hostPath);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(registeredDrivers(directory), declaredDrivers);
    assert.deepEqual(readFileSync(join(decoy, ".git", "config")), before);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
