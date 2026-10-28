#!/usr/bin/env node
/**
 * Docstring coverage gate for this package.
 *
 * Thin launcher over the published fleet analyzer `pm-ops/docstrings`: it runs
 * the analyzer over this package's sources and exits non-zero when any
 * declaration lacks a real JSDoc block, so the gate drops into `release:check`
 * and CI unchanged. Every documentation rule lives in the analyzer; this
 * script only wires its report to the process streams and exit code.
 *
 * @example
 * ```bash
 * node scripts/docstring-gate.ts [repository-root]
 * ```
 */

import { analyzeDocstringCoverage } from "pm-ops/docstrings";

import { commandRoot, isMainInvocation } from "./main-invocation.ts";

/** Process and stream boundaries accepted by the docstring gate. */
export interface DocstringGateOptions {
  /** Repository root to analyze; defaults to this package. */
  readonly root?: string;
  /** Success logger used by the CLI and the suite. */
  readonly log?: (message: string) => void;
  /** Failure logger used by the CLI and the suite. */
  readonly error?: (message: string) => void;
  /** Exit boundary; injectable so the suite can assert the failure path. */
  readonly exit?: (code: number) => void;
}

/**
 * Analyze one repository and enforce the package documentation contract.
 *
 * A violation fails the gate with one line per finding so the author can fix
 * the docstrings without reading analyzer internals; a clean tree prints the
 * scan size as the only success line.
 *
 * @param options - Optional repository root plus injectable loggers and exit.
 */
export function runDocstringGate(options: DocstringGateOptions = {}): void {
  const root = options.root ?? process.cwd();
  const report = analyzeDocstringCoverage({ root });
  if (report.violations.length > 0) {
    const findings = report.violations
      .map(violation => `${violation.file}:${violation.line} ${violation.symbol} — ${violation.reason}`)
      .join("\n");
    (options.error ?? console.error)(
      `docstring-gate: ${report.violations.length} violation(s) across ${report.files_scanned} file(s):\n${findings}`,
    );
    return (options.exit ?? process.exit)(1);
  }
  (options.log ?? console.log)(
    `docstring-gate: ${report.files_scanned} file(s), ${report.declarations_checked} declaration(s) documented.`,
  );
}

if (isMainInvocation(process.argv, import.meta.url)) {
  const root = commandRoot(process.argv[2]);
  if (root !== undefined) runDocstringGate({ root });
}