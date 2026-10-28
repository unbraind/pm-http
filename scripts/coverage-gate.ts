#!/usr/bin/env node
/**
 * Coverage gate for the package test suite.
 *
 * Runs the published `c8` reporter over `node --test`, with the TypeScript
 * sources measured directly: Node executes `.ts` natively, so the reported
 * line numbers are the ones an author edits, and `--all` adds every authored
 * file matched by the include patterns even when no test loads it, so an
 * untested module appears at zero instead of vanishing from the percentages.
 *
 * The gate exists for three things a bare `c8 --check-coverage` cannot do:
 *
 * - the thresholds it enforces (statements, branches, functions and lines) are
 *   read from the `coverageGate` block of `package.json`, so a threshold change
 *   shows up in review as a deliberate diff next to the scripts it governs;
 * - the report is invalidated before the run and again on every failure, so a
 *   leftover report from an earlier, broader run can never satisfy a check;
 * - the reported file list is reconciled against a fresh walk of the configured
 *   source locations, so a file the glob machinery fails to match cannot
 *   escape the measurement — it is named as a violation instead.
 *
 * There is deliberately no ignore list. An executable module must be exercised
 * by the suite; a module that erases to nothing reports vacuous full coverage
 * once any test loads it, so the remedy for a type-only finding is an import,
 * never an exemption.
 *
 * @example
 * ```bash
 * node scripts/coverage-gate.ts [repository-root]
 * ```
 */

import { testEnvironment } from './environment.ts';
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";

import { commandRoot, isMainInvocation } from "./main-invocation.ts";

/** Coverage dimensions enforced independently, matching the c8 summary keys. */
const DIMENSIONS = ["statements", "branches", "functions", "lines"] as const;

/** One dimension name from the enforced set. */
type CoverageDimension = (typeof DIMENSIONS)[number];

/** Validated per-dimension thresholds read from the manifest block. */
type ThresholdTable = Record<CoverageDimension, number>;

/**
 * Directory names never treated as authored source while walking a configured
 * location, so a `sources: ["."]` style entry cannot pull in tests, build
 * output or installed dependencies.
 */
const SKIPPED_DIRECTORY_NAMES = [
  "node_modules",
  "dist",
  "dist-test",
  "coverage",
  "test",
  "tests",
  ".agents",
  ".git",
  ".github",
];

/** Glob patterns kept out of the c8 report, aligned with the skipped names. */
const C8_EXCLUDES = [
  "test/**",
  "tests/**",
  "dist/**",
  "dist-test/**",
  "node_modules/**",
  "coverage/**",
  ".agents/**",
  ".github/**",
  "**/*.d.ts",
];

/** The `coverageGate` block read from `package.json`. */
interface CoverageGateConfig {
  /**
   * Source locations the gate requires to appear in the report. Each entry is
   * a directory, walked recursively for `.ts` files, or one source file; a
   * directory is enumerated at run time so a file added later joins the
   * required set automatically instead of freezing at configuration time.
   */
  readonly sources: readonly string[];
  /** Additional directory names skipped while walking, beyond the defaults. */
  readonly skipDirs?: readonly string[];
  /** Test file arguments handed to `node --test`. */
  readonly tests: readonly string[];
  /** Threshold enforced per dimension; every entry must be a number. */
  readonly thresholds?: Partial<ThresholdTable>;
}

/** The `package.json` fields this gate reads. */
interface PackageManifest {
  readonly coverageGate?: CoverageGateConfig;
}

/** One dimension block from c8's `coverage-summary.json`. */
interface MetricSummary {
  /** Covered percentage for the dimension, already rounded by the reporter. */
  readonly pct: number;
}

/** c8's summary: one metric block per dimension for `total` and for each file. */
type CoverageSummary = {
  readonly [entry: string]: { readonly [dimension: string]: MetricSummary };
};

/** Injectable runner and stream boundaries, so the suite measures this gate with itself. */
export interface CoverageGateOptions {
  /**
   * Runner override: the executable and the launcher script it is handed.
   * Tests substitute a failing or report-less runner to reach the refusal
   * paths without sabotaging a real report.
   */
  readonly runner?: { readonly executable: string; readonly script: string };
  /** Success logger used by the CLI and the suite. */
  readonly log?: (message: string) => void;
  /** Failure logger used by the CLI and the suite. */
  readonly error?: (message: string) => void;
}

/** The walked source inventory and the c8 include patterns covering it. */
interface SourceInventory {
  /** Repository-relative POSIX paths the report must contain. */
  readonly required: readonly string[];
  /** One `--include` pattern per configured location, plus the package entry. */
  readonly include: readonly string[];
}

/**
 * Gate failure carrying a diagnostic for the error stream. Thrown rather than
 * calling `process.exit` so the suite can drive every refusal without ending
 * the test process.
 */
class CoverageGateFailure extends Error {}

/**
 * Read and validate the `coverageGate` block of one repository root.
 *
 * A missing block, a missing or non-numeric threshold, or an empty test list
 * each fail closed with a remediation message, because a gate that guesses at
 * its configuration reports numbers nobody configured.
 */
function loadConfiguration(root: string): { config: CoverageGateConfig; thresholds: ThresholdTable } {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageManifest;
  const config = manifest.coverageGate;
  if (config === undefined) throw new CoverageGateFailure("package.json has no `coverageGate` block.");
  const thresholds: ThresholdTable = { statements: 0, branches: 0, functions: 0, lines: 0 };
  for (const dimension of DIMENSIONS) {
    const value = config.thresholds?.[dimension];
    if (typeof value !== "number") {
      throw new CoverageGateFailure(`coverageGate.thresholds.${dimension} is missing or not a number.`);
    }
    thresholds[dimension] = value;
  }
  if (!Array.isArray(config.tests) || config.tests.length === 0) {
    throw new CoverageGateFailure("coverageGate.tests must list at least one test entry.");
  }
  return { config, thresholds };
}

/**
 * Recursively collect the authored TypeScript files below one directory,
 * pruning skipped directory names and declaration files.
 */
function walkDirectory(root: string, directory: string, skipped: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipped.has(entry.name)) found.push(...walkDirectory(root, join(directory, entry.name), skipped));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      found.push(relative(root, join(directory, entry.name)).split(sep).join("/"));
    }
  }
  return found;
}

/**
 * Walk the configured source locations and add the package entry point.
 *
 * The entry file at the repository root is authored TypeScript outside the
 * configured directories, so the gate requires it whenever it exists instead
 * of trusting the configuration to remember it. Both the required file list
 * and the include patterns come from this one walk, so the two cannot drift
 * apart between the presence check and the threshold check.
 */
function inventorySources(root: string, config: CoverageGateConfig, skipped: ReadonlySet<string>): SourceInventory {
  const required: string[] = [];
  const include: string[] = [];
  for (const source of config.sources) {
    const target = resolve(root, source);
    const name = relative(root, target).split(sep).join("/") || ".";
    if (!existsSync(target)) {
      throw new CoverageGateFailure(`coverageGate.sources names ${name}, which does not exist.`);
    }
    if (statSync(target).isDirectory()) {
      include.push(name === "." ? "**/*.ts" : `${name}/**/*.ts`);
      required.push(...walkDirectory(root, target, skipped));
    } else {
      if (!target.endsWith(".ts") || target.endsWith(".d.ts")) {
        throw new CoverageGateFailure(
          `coverageGate.sources names ${name}, which is not a TypeScript source file.`,
        );
      }
      include.push(name);
      required.push(name);
    }
  }
  const entry = relative(root, join(root, "index.ts"));
  if (existsSync(join(root, entry)) && !required.includes(entry)) {
    required.push(entry);
    include.push(entry);
  }
  if (required.length === 0) {
    throw new CoverageGateFailure("source walk found no files; check `coverageGate.sources`.");
  }
  return { required, include };
}

/**
 * Resolve the c8 launcher from this package's own dependencies.
 *
 * Resolution, not a hardcoded path, keeps the gate working from any working
 * directory, and a genuinely missing reporter propagates the resolver's error
 * to the caller's failure handling instead of being papered over here.
 */
function resolveC8Launcher(): string {
  return createRequire(import.meta.url).resolve("c8/bin/c8.js");
}

/**
 * Run c8 over the configured tests and return the runner's exit status.
 *
 * `NODE_V8_COVERAGE` and `NODE_TEST_CONTEXT` are removed from the child
 * environment: this gate itself runs inside an outer coverage run during the
 * suite, and the inherited raw-coverage directory would make the inner
 * reporter read the outer run's dumps, while the inherited test-runner context
 * makes the inner `node --test` believe it is a recursive invocation and skip
 * every test file.
 */
function runC8(root: string, config: CoverageGateConfig, inventory: SourceInventory, options: CoverageGateOptions): number {
  const runner = options.runner ?? { executable: process.execPath, script: resolveC8Launcher() };
  const env = { ...testEnvironment(process.env), TZ: "UTC" } as NodeJS.ProcessEnv;
  for (const key of Object.keys(env)) if (/^NODE_V8_COVERAGE$/i.test(key)) delete env[key];
  const excludes = [...C8_EXCLUDES, ...(config.skipDirs ?? []).map(name => `**/${name}/**`)];
  const result = spawnSync(
    runner.executable,
    [
      runner.script,
      "--all",
      "--temp-directory",
      join(root, "coverage", "tmp"),
      ...inventory.include.flatMap(pattern => ["--include", pattern]),
      ...excludes.flatMap(pattern => ["--exclude", pattern]),
      "--reporter=json-summary",
      "--reporter=json",
      "--reporter=lcov",
      "--reporter=text",
      "--reports-directory",
      join(root, "coverage"),
      process.execPath,
      "--test",
      "--test-concurrency=2",
      ...config.tests,
    ],
    { cwd: root, env, stdio: "inherit" },
  );
  if (result.error !== undefined) throw new CoverageGateFailure(`failed to start the c8 reporter: ${result.error.message}`);
  return result.status ?? 1;
}

/**
 * Reconcile the written summary against the walked inventory and thresholds.
 *
 * Every required file must appear as its own entry — c8's aggregate total is
 * computed only over the files the report contains, so a file the reporter
 * never emitted would otherwise be measurable by nobody — and each dimension
 * must meet its configured percentage on that same report.
 */
function reconcile(root: string, required: readonly string[], thresholds: ThresholdTable): string[] {
  const summaryPath = join(root, "coverage", "coverage-summary.json");
  if (!existsSync(summaryPath)) {
    throw new CoverageGateFailure("c8 exited successfully but wrote no coverage summary; inspect the runner output above.");
  }
  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as CoverageSummary;
  const reported = new Set(Object.keys(summary).map(key => relative(root, resolve(root, key)).split(sep).join("/")));
  const totals = summary["total"] as { readonly [dimension in CoverageDimension]: MetricSummary };
  return [
    ...required
      .filter(file => !reported.has(file))
      .map(file => `${file}: never loaded by the suite and absent from the report; import it from a test.`),
    ...DIMENSIONS.filter(dimension => totals[dimension].pct < thresholds[dimension])
      .map(dimension => `${dimension}: ${totals[dimension].pct}% covered, ${thresholds[dimension]}% required.`),
  ];
}

/**
 * Run the whole gate against one repository root and return the exit code.
 *
 * Reports are invalidated before the run and again on every failure, so a red
 * run leaves no green-looking artefact behind; a clean run leaves the json,
 * json-summary and lcov reports in place for consumers.
 *
 * @param root - Repository root whose `package.json` configures the gate.
 * @param options - Optional runner and stream boundaries for the suite.
 * @returns The process exit code: zero only on a fully measured, fully covered run.
 */
export function runCoverageGate(root: string, options: CoverageGateOptions = {}): number {
  const log = options.log ?? console.log;
  const failure = options.error ?? console.error;
  const reports = join(root, "coverage");
  try {
    const { config, thresholds } = loadConfiguration(root);
    const skipped = new Set(SKIPPED_DIRECTORY_NAMES);
    for (const name of config.skipDirs ?? []) skipped.add(name);
    const inventory = inventorySources(root, config, skipped);
    rmSync(reports, { recursive: true, force: true });
    const status = runC8(root, config, inventory, options);
    if (status !== 0) {
      rmSync(reports, { recursive: true, force: true });
      return status;
    }
    const violations = reconcile(root, inventory.required, thresholds);
    if (violations.length > 0) {
      rmSync(reports, { recursive: true, force: true });
      failure(`coverage-gate: ${violations.length} violation(s) after the run:\n${violations.join("\n")}`);
      return 1;
    }
    log(`coverage-gate: ${inventory.required.length} source file(s) reported; every threshold met.`);
    return 0;
  } catch (gateFailure) {
    rmSync(reports, { recursive: true, force: true });
    failure(`coverage-gate: ${gateFailure}`);
    return 1;
  }
}

if (isMainInvocation(process.argv, import.meta.url)) {
  const root = commandRoot(process.argv[2]);
  if (root !== undefined) process.exitCode = runCoverageGate(root);
}