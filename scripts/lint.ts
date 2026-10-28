/**
 * Lint gate: a thin launcher over the canonical fleet ESLint policy in `pm-ops/eslint`.
 */
import { runLintGate } from "pm-ops/eslint";

process.exitCode = await runLintGate();