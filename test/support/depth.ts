/**
 * Keep full local/release depth by default; quick runs the same deterministic
 * seed prefix at one tenth depth, with at least 25 cases (capped by full count).
 * Callers keep seed generation and per-case assertions identical in both modes.
 */
export function testDepth(full: number): number {
  return process.env.PM_TEST_DEPTH === "quick" ? Math.min(full, Math.max(25, Math.ceil(full / 10))) : full;
}

/** Scale harness deadlines only; reject invalid scales before starting children. */
export function testTime(milliseconds: number): number {
  const scale = Number(process.env.PM_TEST_TIME_SCALE ?? '1');
  const result = Math.ceil(milliseconds * scale);
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isSafeInteger(result) || result > 2_147_483_647) throw new Error('Invalid PM_TEST_TIME_SCALE');
  return result;
}
