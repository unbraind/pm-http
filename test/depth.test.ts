import test from 'node:test';
import assert from 'node:assert/strict';
import { testDepth, testTime } from './support/depth.ts';
import { environment } from './helpers.ts';

test('depth defaults to full and quick keeps a bounded deterministic prefix', () => {
  const previous = process.env.PM_TEST_DEPTH;
  try {
    delete process.env.PM_TEST_DEPTH; assert.equal(testDepth(500), 500);
    process.env.PM_TEST_DEPTH = 'quick'; assert.equal(testDepth(500), 50); assert.equal(testDepth(100), 25); assert.equal(testDepth(10), 10);
  } finally { if (previous === undefined) delete process.env.PM_TEST_DEPTH; else process.env.PM_TEST_DEPTH = previous; }
});

test('harness timeouts round milliseconds and reject invalid scale before spawning', () => {
  const previous = process.env.PM_TEST_TIME_SCALE;
  try {
    delete process.env.PM_TEST_TIME_SCALE; assert.equal(testTime(101), 101);
    process.env.PM_TEST_TIME_SCALE = '1.5'; assert.equal(testTime(101), 152);
    for (const scale of ['', '0', '-1', 'NaN', 'Infinity', '100000000']) {
      process.env.PM_TEST_TIME_SCALE = scale; assert.throws(() => testTime(30000), /PM_TEST_TIME_SCALE/);
    }
  } finally { if (previous === undefined) delete process.env.PM_TEST_TIME_SCALE; else process.env.PM_TEST_TIME_SCALE = previous; }
});

// The TLS fixture replaces the environment, so inherited scale must be explicit.
test('replacement child environments preserve the harness scale', async () => {
  const previous = process.env.PM_TEST_TIME_SCALE;
  try {
    process.env.PM_TEST_TIME_SCALE = '3';
    assert.equal(environment('fixture', 'tracker').PM_TEST_TIME_SCALE, '3');
    delete process.env.PM_TEST_TIME_SCALE;
    assert.equal(environment('fixture', 'tracker').PM_TEST_TIME_SCALE, undefined);
  } finally { if (previous === undefined) delete process.env.PM_TEST_TIME_SCALE; else process.env.PM_TEST_TIME_SCALE = previous; }
});
