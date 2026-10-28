/**
 * Shared entry-point guard for this package's executable scripts.
 *
 * The coverage gate and the docstring gate must behave identically when their
 * suites import them versus when a developer or CI executes them as `main`, so
 * the comparison lives in exactly one measured module instead of drifting
 * between per-script copies.
 */

import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Decide whether the running process was started for this module rather than
 * importing it for measurement.
 *
 * Both sides are canonicalised through `realpathSync` before comparison. A
 * launcher reached through a symlink (an npm bin shim, a linked workspace)
 * would otherwise compare unequal and skip its gate silently, and under
 * `--preserve-symlinks-main` the entry path stays un-resolved while
 * `import.meta.url` is already real, which would invert the answer on a direct
 * invocation. Canonicalising both sides removes the dependence on how Node was
 * started.
 *
 * An `argv[1]` that no longer resolves propagates the error instead of
 * answering false: a false answer lets a release check exit 0 having scanned
 * nothing, which is the silent skip this guard exists to prevent, while a
 * thrown error turns the same situation into a loud non-zero exit. A genuinely
 * different entry path still returns false, which is how a test import
 * declines to run main wiring.
 *
 * @param argv - The process argv to inspect; `argv[1]` names the entry script.
 * @param moduleUrl - The `import.meta.url` of the module that might be main.
 * @returns True when the entry and this module canonicalise to one path.
 */
export function isMainInvocation(argv: readonly string[], moduleUrl: string): boolean {
  const entry = argv[1];
  if (entry === undefined) return false;
  return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
}

/** Resolve an optional CLI root, refusing blanks without exposing the supplied operand. */
export function commandRoot(argument: string | undefined): string | undefined {
  if (argument !== undefined && argument.trim().length === 0) {
    console.error('Expected a nonblank repository root operand');
    process.exitCode = 1;
    return undefined;
  }
  return resolve(argument ?? process.cwd());
}
